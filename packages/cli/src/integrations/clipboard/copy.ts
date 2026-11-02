/**
 * Put text on the operator's clipboard: the machine's own clipboard tool first,
 * then the terminal's escape sequence.
 *
 * ## Order
 *
 * 1. Off a remote login, the platform tool: `pbcopy` on macOS; `powershell.exe`
 *    `Set-Clipboard` on Windows and under WSL (never `clip.exe`, which mangles
 *    anything outside the console code page); `wl-copy`, `xclip` or `xsel` on
 *    Linux. The text goes in on standard input, never in the command line, and
 *    the tool gets {@link NATIVE_TIMEOUT_MS} to finish.
 * 2. The OSC 52 request ({@link buildClipboardSequence}) as well, unless the
 *    tool worked on Linux/WSL and the terminal is VTE-based, whose older
 *    releases print an unknown sequence instead of ignoring it. Inside tmux the
 *    request is also loaded into tmux's paste buffer.
 *
 * ## Never in the way of typing
 *
 * The tool runs asynchronously. Only one copy runs at a time; a copy asked for
 * while another runs waits, and a newer one replaces it. A copy whose caller no
 * longer wants it (`wanted()` returns false by the time its turn comes) never
 * starts a process.
 *
 * Every program is a fixed argv with the text on stdin: no shell, no
 * interpolation. The runner and the environment are injected so a test names
 * the machine it describes and never reaches a real clipboard.
 */

import { spawn } from 'node:child_process'
import { constants, accessSync, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import { readWslMountRoot, wslSystem32 } from '../../context/environment.js'
import {
	type ClipboardEnv,
	MAX_CLIPBOARD_TEXT_BYTES,
	type TerminalClipboardOutput,
	buildClipboardSequence,
} from './text.js'

/** How long a platform clipboard tool may take before it counts as failed. */
export const NATIVE_TIMEOUT_MS = 2_000

/** Runs one program with `input` on its stdin; resolves whether it exited 0 in time. */
export type ClipboardRunner = (
	command: string,
	args: readonly string[],
	input: string,
	timeoutMs: number,
) => Promise<boolean>

export interface CopyHost {
	readonly platform?: NodeJS.Platform
	readonly env?: NodeJS.ProcessEnv
	/** Absolute path of a program on PATH, or null. */
	readonly which?: (name: string, env: NodeJS.ProcessEnv) => string | null
	readonly exists?: (path: string) => boolean
	/** Where the Windows drives are mounted under WSL. */
	readonly mountRoot?: string
	readonly run?: ClipboardRunner
}

export type CopyOutcome = {
	readonly chars: number
	readonly bytes: number
	/** The tool that took the text, or null when none did. */
	readonly native: string | null
	/** What became of the terminal request. */
	readonly osc52: 'sent' | 'skipped' | 'too-large' | 'unavailable' | 'failed'
	/** The text also went into tmux's paste buffer. */
	readonly tmuxBuffer: boolean
}

/** The PowerShell script: UTF-8 in and out, the text read whole from stdin. */
export const POWERSHELL_COPY_SCRIPT = [
	'$u = New-Object System.Text.UTF8Encoding $false',
	'[Console]::InputEncoding = $u',
	'[Console]::OutputEncoding = $u',
	'Set-Clipboard -Value ([Console]::In.ReadToEnd())',
].join('; ')

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_COPY_SCRIPT]

export const realRunner: ClipboardRunner = (command, args, input, timeoutMs) =>
	new Promise((resolve) => {
		let settled = false
		const done = (ok: boolean): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(ok)
		}
		let child: ReturnType<typeof spawn> | undefined
		const timer = setTimeout(() => {
			child?.kill('SIGKILL')
			done(false)
		}, timeoutMs)
		try {
			child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
		} catch {
			done(false)
			return
		}
		child.on('error', () => done(false))
		child.on('close', (code) => done(code === 0))
		child.stdin?.on('error', () => done(false))
		child.stdin?.end(Buffer.from(input, 'utf8'))
	})

function realWhich(name: string, env: NodeJS.ProcessEnv): string | null {
	for (const directory of (env.PATH ?? '').split(delimiter)) {
		// A relative or empty PATH member would hand executable authority to the cwd.
		if (!directory || !isAbsolute(directory)) continue
		const candidate = join(directory, name)
		try {
			accessSync(candidate, constants.X_OK)
			return candidate
		} catch {
			// Keep looking.
		}
	}
	return null
}

const isSsh = (env: NodeJS.ProcessEnv): boolean =>
	Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)

const isWsl = (env: NodeJS.ProcessEnv): boolean => Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)

/** Terminals whose older releases print an unknown OSC sequence instead of ignoring it. */
const printsUnknownSequences = (env: NodeJS.ProcessEnv): boolean => Boolean(env.VTE_VERSION)

/** PowerShell under WSL: on PATH, else under the Windows drive. Never `clip.exe`. */
function wslPowershell(host: Required<Pick<CopyHost, 'env' | 'which' | 'exists'>> & CopyHost) {
	const found = host.which('powershell.exe', host.env)
	if (found) return found
	const root = host.mountRoot ?? readWslMountRoot()
	const path = `${wslSystem32(root)}/WindowsPowerShell/v1.0/powershell.exe`
	return host.exists(path) ? path : null
}

interface NativeTry {
	readonly name: string
	readonly command: string
	readonly args: readonly string[]
	/** Extra writes to the other selection; their failure changes nothing. */
	readonly also?: readonly (readonly string[])[]
}

function nativeCandidates(host: CopyHost): readonly NativeTry[] {
	const platform = host.platform ?? process.platform
	const env = host.env ?? process.env
	const which = host.which ?? realWhich
	const exists = host.exists ?? existsSync
	const found = (name: string): string | null => which(name, env)
	if (platform === 'darwin') {
		const pbcopy = found('pbcopy')
		return pbcopy ? [{ name: 'pbcopy', command: pbcopy, args: [] }] : []
	}
	if (platform === 'win32') {
		return [{ name: 'powershell', command: 'powershell', args: POWERSHELL_ARGS }]
	}
	if (platform !== 'linux') return []
	if (isWsl(env)) {
		const powershell = wslPowershell({ ...host, env, which, exists })
		return powershell
			? [{ name: 'powershell.exe', command: powershell, args: POWERSHELL_ARGS }]
			: []
	}
	const tries: NativeTry[] = []
	const wlCopy = env.WAYLAND_DISPLAY ? found('wl-copy') : null
	if (wlCopy) tries.push({ name: 'wl-copy', command: wlCopy, args: [], also: [['--primary']] })
	const xclip = env.DISPLAY ? found('xclip') : null
	if (xclip)
		tries.push({
			name: 'xclip',
			command: xclip,
			args: ['-selection', 'clipboard'],
			also: [['-selection', 'primary']],
		})
	const xsel = env.DISPLAY ? found('xsel') : null
	if (xsel)
		tries.push({
			name: 'xsel',
			command: xsel,
			args: ['--clipboard', '--input'],
			also: [['--primary', '--input']],
		})
	return tries
}

interface Pending {
	readonly text: string
	readonly wanted: () => boolean
	readonly resolve: (outcome: CopyOutcome | null) => void
}

export interface ClipboardCopier {
	/**
	 * Copies `text`. Resolves null when the copy was dropped: superseded by a newer
	 * one while waiting, or no longer wanted when its turn came.
	 */
	copy(text: string, wanted?: () => boolean): Promise<CopyOutcome | null>
}

export function createClipboardCopier(
	output: TerminalClipboardOutput,
	host: CopyHost = {},
): ClipboardCopier {
	const env = host.env ?? process.env
	const platform = host.platform ?? process.platform
	const run = host.run ?? realRunner
	const which = host.which ?? realWhich
	let running = false
	let pending: Pending | undefined

	const perform = async (text: string): Promise<CopyOutcome> => {
		const bytes = Buffer.byteLength(text, 'utf8')
		const chars = [...text].length
		let native: string | null = null
		if (!isSsh(env)) {
			for (const candidate of nativeCandidates(host)) {
				if (await run(candidate.command, candidate.args, text, NATIVE_TIMEOUT_MS)) {
					native = candidate.name
					for (const extra of candidate.also ?? [])
						await run(candidate.command, extra, text, NATIVE_TIMEOUT_MS)
					break
				}
			}
		}
		const linuxLike = platform === 'linux'
		let osc52: CopyOutcome['osc52']
		let tmuxBuffer = false
		if (native !== null && linuxLike && printsUnknownSequences(env)) osc52 = 'skipped'
		else if (!output.isTTY) osc52 = 'unavailable'
		else if (bytes > MAX_CLIPBOARD_TEXT_BYTES) osc52 = 'too-large'
		else {
			try {
				output.write(buildClipboardSequence(text, env))
				osc52 = 'sent'
			} catch {
				osc52 = 'failed'
			}
			const tmux = env.TMUX ? which('tmux', env) : null
			if (tmux) {
				tmuxBuffer =
					(await run(tmux, ['load-buffer', '-w', '-'], text, NATIVE_TIMEOUT_MS)) ||
					(await run(tmux, ['load-buffer', '-'], text, NATIVE_TIMEOUT_MS))
			}
		}
		return { chars, bytes, native, osc52, tmuxBuffer }
	}

	const drain = async (first: Pending): Promise<void> => {
		let next: Pending | undefined = first
		running = true
		try {
			while (next) {
				const job: Pending = next
				pending = undefined
				if (!job.wanted()) job.resolve(null)
				else {
					try {
						job.resolve(await perform(job.text))
					} catch {
						job.resolve(null)
					}
				}
				next = pending
			}
		} finally {
			running = false
		}
	}

	return {
		copy(text, wanted = () => true) {
			return new Promise((resolve) => {
				const job: Pending = { text, wanted, resolve }
				if (running) {
					pending?.resolve(null)
					pending = job
					return
				}
				void drain(job)
			})
		},
	}
}

/** The key that makes the terminal select text by itself. */
export function bypassKey(env: NodeJS.ProcessEnv = process.env): string {
	return env.TERM_PROGRAM === 'iTerm.app'
		? 'Option'
		: env.TERM_PROGRAM === 'Apple_Terminal'
			? 'Fn'
			: 'Shift'
}

function characters(n: number): string {
	return `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`
}

/**
 * One line telling the operator what happened. `key` is the modifier that makes
 * their terminal select text by itself.
 */
export function describeCopy(
	outcome: CopyOutcome,
	key = 'Shift',
	what?: string,
): { text: string; ok: boolean } {
	const n = `${characters(outcome.chars)}${what ? ` (${what})` : ''}`
	if (outcome.native !== null) return { text: `Copied ${n} to the clipboard.`, ok: true }
	if (outcome.tmuxBuffer)
		return { text: `Copied ${n} to the tmux buffer. Paste with prefix + ].`, ok: true }
	switch (outcome.osc52) {
		case 'sent':
			return {
				text: `Sent ${n} to your clipboard. If paste fails, hold ${key} while selecting.`,
				ok: true,
			}
		case 'too-large': {
			const kb = (b: number): string => `${Math.ceil(b / 1000).toLocaleString('en-US')} KB`
			return {
				text: `That selection is too large to copy (${kb(outcome.bytes)}; the limit is ${kb(MAX_CLIPBOARD_TEXT_BYTES)}).`,
				ok: false,
			}
		}
		default:
			return {
				text: `Couldn't copy ${n}. Select with ${key} held, then use your terminal's Copy.`,
				ok: false,
			}
	}
}

export type { ClipboardEnv }
