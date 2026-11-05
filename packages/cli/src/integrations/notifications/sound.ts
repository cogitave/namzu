/**
 * A sound when a turn needs the person back.
 *
 * | Player | When | How |
 * |---|---|---|
 * | `powershell` | Windows, and WSL through interop | `System.Media.SoundPlayer` on the file |
 * | `afplay` | macOS | the file |
 * | `paplay`, `pw-play`, `aplay` | Linux | the first one on `PATH` |
 *
 * The sound plays where Namzu runs, so over SSH it is silent: there is no
 * protocol for a terminal to play a sound for a remote program, and guessing
 * at the local machine would be wrong more often than right. Nothing here can
 * fail a turn. A missing player, an unwritable cache or a refused spawn leaves
 * the person with exactly what they had before the sound existed.
 *
 * The file path reaches PowerShell through the environment, never as script
 * text; the script is a constant (see `windows-toast.ts` for why).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { namzuHomePath } from '../state/home.js'
import { selectDesktopBackend } from './desktop.js'
import { type SoundKind, chimeWav } from './sound/chime.js'

export type { SoundKind } from './sound/chime.js'

/** A moment the TUI may sound for, before it is mapped to a sound. */
export type SoundMoment =
	| { readonly kind: 'approval-required' }
	| { readonly kind: 'turn-settled'; readonly outcome: 'completed' | 'stopped' | 'failed' }
	| { readonly kind: 'idle-prompt' }

/**
 * A turn shorter than this is one the person was watching, so a sound would
 * announce what they have just read. Only a finished turn is held back this
 * way; a stop, a failure and an approval always sound.
 */
export const SOUND_MIN_TURN_MS = 10_000

/** Two sounds closer than this are one moment. */
const SOUND_SPACING_MS = 1_500

/** The process-wide switch: `NAMZU_NO_SOUND=1` plays nothing, whatever the config says. */
export const SOUND_KILL_SWITCH = 'NAMZU_NO_SOUND'

/** The sound for a moment, or `undefined` when the moment stays quiet. */
export function soundFor(moment: SoundMoment, turnMs: number | undefined): SoundKind | undefined {
	if (moment.kind === 'approval-required') return 'request'
	if (moment.kind === 'idle-prompt') return undefined
	if (moment.outcome !== 'completed') return 'request'
	return turnMs !== undefined && turnMs >= SOUND_MIN_TURN_MS ? 'done' : undefined
}

export interface SoundPlayer {
	readonly name: string
	readonly command: string
	readonly args: (file: string) => string[]
	readonly env?: (base: NodeJS.ProcessEnv, file: string) => NodeJS.ProcessEnv
	readonly cwd?: string
}

/** Constant, like the toast script: the file reaches it only as `$env:NAMZU_SOUND_FILE`. */
export const PLAY_SCRIPT =
	"$ErrorActionPreference = 'Stop'; (New-Object System.Media.SoundPlayer $env:NAMZU_SOUND_FILE).PlaySync()"

const POWERSHELL_ARGS = [
	'-NoProfile',
	'-NonInteractive',
	'-ExecutionPolicy',
	'Bypass',
	'-EncodedCommand',
	Buffer.from(PLAY_SCRIPT, 'utf16le').toString('base64'),
]

export interface SoundProbe {
	readonly platform?: NodeJS.Platform
	readonly env?: NodeJS.ProcessEnv
	readonly exists?: (path: string) => boolean
	/** The desktop backend, as `selectDesktopBackend` reports it. */
	readonly desktop?: ReturnType<typeof selectDesktopBackend>
}

function onPath(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, name: string) {
	for (const dir of (env.PATH ?? '').split(':')) {
		// Never search Windows drives: a lookup there costs seconds under WSL.
		if (!dir || dir.startsWith('/mnt/')) continue
		const candidate = join(dir, name)
		if (exists(candidate)) return candidate
	}
	return undefined
}

/** The program that plays a WAV on this machine, or `undefined` when none does. */
export function selectSoundPlayer(probe: SoundProbe = {}): SoundPlayer | undefined {
	const platform = probe.platform ?? process.platform
	const env = probe.env ?? process.env
	const exists = probe.exists ?? existsSync
	if (platform === 'darwin') {
		return { name: 'afplay', command: '/usr/bin/afplay', args: (file) => [file] }
	}
	const desktop = probe.desktop ?? selectDesktopBackend({ platform, env, exists })
	if (desktop.kind === 'windows-toast') {
		return {
			name: 'powershell',
			command: 'powershell.exe',
			args: () => POWERSHELL_ARGS,
			env: (base, file) => ({ ...base, NAMZU_SOUND_FILE: file }),
		}
	}
	if (desktop.kind === 'wsl-toast' && desktop.command) {
		// `WSLENV`'s `/p` flag turns a Linux path into the Windows path on the way over.
		const shared = desktop.env?.({}, '', '') ?? {}
		return {
			name: 'powershell',
			command: desktop.command,
			args: () => POWERSHELL_ARGS,
			env: (base, file) => {
				const existing = (base.WSLENV ?? '')
					.split(':')
					.filter((entry) => entry && !entry.startsWith('NAMZU_SOUND_FILE'))
				return {
					...base,
					...(shared.WSL_INTEROP ? { WSL_INTEROP: shared.WSL_INTEROP } : {}),
					NAMZU_SOUND_FILE: file,
					WSLENV: [...existing, 'NAMZU_SOUND_FILE/p'].join(':'),
				}
			},
			...(desktop.cwd ? { cwd: desktop.cwd } : {}),
		}
	}
	for (const [name, args] of [
		['paplay', (file: string) => [file]],
		['pw-play', (file: string) => [file]],
		['aplay', (file: string) => ['-q', file]],
	] as const) {
		const command = onPath(env, exists, name)
		if (command) return { name, command, args }
	}
	return undefined
}

/** Where the rendered sound lives. A new design bumps the version in the name. */
export function soundFilePath(kind: SoundKind, home: string = namzuHomePath()): string {
	return join(home, 'cache', 'sound', `namzu-${kind}-v1.wav`)
}

/** Write the sound if it is not there yet. The rename keeps a half-written file from ever being played. */
export function ensureSoundFile(kind: SoundKind, home?: string): string {
	const file = soundFilePath(kind, home)
	const wav = chimeWav(kind)
	try {
		if (statSync(file).size === wav.length) return file
	} catch {
		// Not written yet.
	}
	mkdirSync(join(file, '..'), { recursive: true })
	const staging = `${file}.${process.pid}.tmp`
	writeFileSync(staging, wav)
	renameSync(staging, file)
	return file
}

export type SoundSpawn = (
	command: string,
	args: readonly string[],
	options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string },
) => void

const defaultSpawn: SoundSpawn = (command, args, options) => {
	const child = spawn(command, [...args], {
		stdio: 'ignore',
		detached: true,
		windowsHide: true,
		env: options.env,
		...(options.cwd ? { cwd: options.cwd } : {}),
	})
	// A missing program is an `error` event, not a throw; it must not reach the process.
	child.on('error', () => {})
	// A player stuck on a dead audio server is not left running for the session.
	const stuck = setTimeout(() => child.kill(), 15_000)
	stuck.unref()
	child.on('exit', () => clearTimeout(stuck))
	child.unref()
}

export interface PlayOptions {
	readonly enabled?: boolean
	readonly isTTY?: boolean
	readonly env?: NodeJS.ProcessEnv
	readonly now?: () => number
	readonly player?: SoundPlayer | undefined
	readonly spawn?: SoundSpawn
	readonly home?: string
}

let lastPlayedAt = Number.NEGATIVE_INFINITY
let cachedPlayer: { readonly value: SoundPlayer | undefined } | undefined

/** For a test: forget the spacing and the player probe. */
export function resetSoundState(): void {
	lastPlayedAt = Number.NEGATIVE_INFINITY
	cachedPlayer = undefined
}

/**
 * Sound the moment if it earns one. Fire and forget; never throws.
 * Returns the sound it started, for the caller's tests.
 */
export function playMoment(
	moment: SoundMoment,
	turnMs: number | undefined,
	options: PlayOptions = {},
): SoundKind | undefined {
	try {
		const env = options.env ?? process.env
		if (options.enabled === false || options.isTTY === false) return undefined
		if (env[SOUND_KILL_SWITCH] === '1') return undefined
		const kind = soundFor(moment, turnMs)
		if (!kind) return undefined
		const now = (options.now ?? Date.now)()
		if (now - lastPlayedAt < SOUND_SPACING_MS) return undefined

		let player: SoundPlayer | undefined
		if ('player' in options) player = options.player
		else {
			cachedPlayer ??= { value: selectSoundPlayer({ env }) }
			player = cachedPlayer.value
		}
		if (!player) return undefined

		const file = ensureSoundFile(kind, options.home)
		lastPlayedAt = now
		const base = player.env ? player.env(env, file) : env
		;(options.spawn ?? defaultSpawn)(player.command, player.args(file), {
			env: base,
			...(player.cwd ? { cwd: player.cwd } : {}),
		})
		return kind
	} catch {
		return undefined
	}
}
