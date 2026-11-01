/**
 * Read an image off the system clipboard, for the composer's paste key.
 *
 * Terminals don't deliver pasted image bytes over stdin, so we ask the
 * platform. macOS uses `osascript` (`«class PNGf»`); Linux tries `xclip` then
 * `wl-paste`; Windows, and WSL where neither Linux tool sees the Windows
 * clipboard, run one fixed PowerShell script that prints the image as base64
 * on stdout. Nothing is written to a Windows temp file and no user-controlled
 * string reaches a command line.
 *
 * Every read is asynchronous: a cold `powershell.exe` takes seconds, and the
 * composer must keep redrawing meanwhile. Non-throwing: every failure comes
 * back as a {@link ClipboardRead} saying which failure it was.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WSL_MOUNT_ROOT, isWslEnv, parseWslMountRoot, readTextOrUndefined } from './wsl.js'

export interface ClipboardImage {
	/** Base64-encoded image bytes (no `data:` prefix). */
	readonly data: string
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
	/** A display name: `Pasted image`, or the file's own name. */
	readonly filename?: string
}

/**
 * What a clipboard read found, and when it found nothing, why.
 *
 * The reason is the whole point of this type. A single `null` for every outcome
 * left the composer with nothing to say, so the paste key with no image behaved
 * exactly like the same key on a machine with no clipboard tool, which behaved
 * exactly like a key that was never wired up. The operator's next move differs
 * in each: copy an image, install a tool, try again, or stop pressing the key.
 */
export type ClipboardRead =
	| { readonly kind: 'image'; readonly image: ClipboardImage }
	/** The clipboard holds image files (a copy in a file manager), not pixels. */
	| { readonly kind: 'files'; readonly paths: readonly string[] }
	/** A tool ran and the clipboard held no image. */
	| { readonly kind: 'empty' }
	/** Nothing on this machine can read an image off the clipboard. */
	| { readonly kind: 'unavailable'; readonly detail: string; readonly wsl?: boolean }
	/** A tool ran but did not finish or gave an answer that is not an image. */
	| { readonly kind: 'failed'; readonly detail: string }

export interface CommandResult {
	/** Exit code, or `null` when killed. */
	readonly code: number | null
	readonly stdout: Buffer
	readonly timedOut: boolean
	/** The program could not be started at all (missing, not executable). */
	readonly spawnFailed: boolean
}

export type CommandRunner = (
	file: string,
	args: readonly string[],
	options: { readonly timeoutMs: number },
) => Promise<CommandResult>

/** The most base64 text a provider accepts for one image (5 MiB). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024

/** Whether an image is small enough to send. A larger one would fail every later turn. */
export function imageFitsProvider(image: ClipboardImage): boolean {
	return image.data.length <= MAX_IMAGE_BASE64_BYTES
}

/** The largest output a clipboard tool may produce before the read is abandoned. */
export const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024
const TOOL_TIMEOUT_MS = 3_000
const POWERSHELL_TIMEOUT_MS = 10_000

export const runCommand: CommandRunner = (file, args, options) =>
	new Promise((resolve) => {
		const chunks: Buffer[] = []
		let size = 0
		let timedOut = false
		let settled = false
		const finish = (result: Omit<CommandResult, 'stdout' | 'timedOut'>): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve({ ...result, stdout: Buffer.concat(chunks), timedOut })
		}
		let child: ReturnType<typeof spawn>
		try {
			child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
		} catch {
			resolve({ code: null, stdout: Buffer.alloc(0), timedOut: false, spawnFailed: true })
			return
		}
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, options.timeoutMs)
		child.stdout?.on('data', (chunk: Buffer) => {
			size += chunk.length
			if (size > MAX_CLIPBOARD_BYTES) {
				timedOut = false
				child.kill('SIGKILL')
				return
			}
			chunks.push(chunk)
		})
		child.on('error', () => finish({ code: null, spawnFailed: true }))
		child.on('close', (code) =>
			finish({ code: size > MAX_CLIPBOARD_BYTES ? null : code, spawnFailed: false }),
		)
	})

export interface ClipboardDeps {
	readonly platform?: NodeJS.Platform
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly run?: CommandRunner
	readonly readText?: (path: string) => string | undefined
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function isPng(buf: Buffer): boolean {
	return buf.length > PNG_MAGIC.length && buf.subarray(0, 4).equals(PNG_MAGIC)
}

/**
 * The PowerShell that reads the clipboard. A constant: it names no user data.
 * It prints either one base64 line (a PNG, shrunk to 2000 px a side) or one
 * `PATH:` line per image file the clipboard holds, and exits 3 for "no image". Any other non-zero exit is an error in the script or the environment.
 */
/** The exit code the script uses for "the clipboard holds no image", and nothing else. */
export const CLIPBOARD_EMPTY_EXIT = 3

export const CLIPBOARD_SCRIPT = [
	"$ProgressPreference='SilentlyContinue'",
	'[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
	'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
	'$i=[Windows.Forms.Clipboard]::GetImage()',
	"if($null -eq $i){$d=[Windows.Forms.Clipboard]::GetData('PNG');if($d -is [IO.Stream]){$i=[Drawing.Image]::FromStream($d)}}",
	'if($null -eq $i){',
	'if([Windows.Forms.Clipboard]::ContainsFileDropList()){$f=@([Windows.Forms.Clipboard]::GetFileDropList()|Where-Object{$_ -match "\\.(png|jpe?g|gif|webp)$"});if($f.Count -gt 0){$f|ForEach-Object{[Console]::Out.WriteLine("PATH:"+$_)};exit 0}}',
	'exit 3}',
	'$m=2000',
	'if($i.Width -gt $m -or $i.Height -gt $m){$s=[Math]::Min($m/$i.Width,$m/$i.Height);$w=[int][Math]::Max(1,[Math]::Floor($i.Width*$s));$h=[int][Math]::Max(1,[Math]::Floor($i.Height*$s));$b=New-Object Drawing.Bitmap $w,$h;$g=[Drawing.Graphics]::FromImage($b);$g.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$g.DrawImage($i,0,0,$w,$h);$g.Dispose();$i=$b}',
	'$ms=New-Object IO.MemoryStream',
	'$i.Save($ms,[Drawing.Imaging.ImageFormat]::Png)',
	'[Console]::Out.WriteLine([Convert]::ToBase64String($ms.ToArray()))',
].join(';')

export function powershellArgs(script: string): string[] {
	return [
		'-NoProfile',
		'-NonInteractive',
		'-Sta',
		'-EncodedCommand',
		Buffer.from(script, 'utf16le').toString('base64'),
	]
}

/**
 * Read what a PowerShell run printed: a PNG as one base64 line, file lines, or
 * nothing. Banner and byte-order-mark noise is ignored; only a line that is
 * base64 and decodes to a PNG counts.
 */
export function parsePowershellOutput(stdout: Buffer): ClipboardRead {
	const lines = stdout
		.toString('utf8')
		.replace(/^﻿/, '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	const paths = lines.filter((line) => line.startsWith('PATH:')).map((line) => line.slice(5))
	if (paths.length > 0) return { kind: 'files', paths }
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? ''
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) continue
		const bytes = Buffer.from(line, 'base64')
		if (isPng(bytes)) {
			return {
				kind: 'image',
				image: { data: line, mediaType: 'image/png', filename: 'Pasted image' },
			}
		}
	}
	return { kind: 'failed', detail: 'the clipboard reader printed no image' }
}

async function runPowershell(
	run: CommandRunner,
	candidates: readonly string[],
): Promise<ClipboardRead | 'unresolved'> {
	for (const file of candidates) {
		const result = await run(file, powershellArgs(CLIPBOARD_SCRIPT), {
			timeoutMs: POWERSHELL_TIMEOUT_MS,
		})
		if (result.spawnFailed) continue
		if (result.timedOut) return { kind: 'failed', detail: 'timed out' }
		if (result.code === CLIPBOARD_EMPTY_EXIT && result.stdout.length === 0) return { kind: 'empty' }
		if (result.code !== 0) return { kind: 'failed', detail: `exit ${String(result.code)}` }
		return parsePowershellOutput(result.stdout)
	}
	return 'unresolved'
}

/** Where `powershell.exe` may be: the PATH, then the drive mounts' fixed location. */
export function powershellCandidates(mountRoot: string): string[] {
	const tail = 'c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
	const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`
	return [...new Set(['powershell.exe', `${DEFAULT_WSL_MOUNT_ROOT}${tail}`, `${root}${tail}`])]
}

export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<ClipboardRead> {
	const platform = deps.platform ?? process.platform
	const env = deps.env ?? process.env
	const run = deps.run ?? runCommand
	const readText = deps.readText ?? readTextOrUndefined
	try {
		switch (platform) {
			case 'darwin':
				return await readMac(run)
			case 'win32': {
				const result = await runPowershell(run, ['powershell'])
				return result === 'unresolved'
					? { kind: 'unavailable', detail: 'PowerShell could not be started' }
					: result
			}
			case 'linux': {
				const wsl = isWslEnv({ platform, env, readText })
				return await readLinux(run, wsl, readText)
			}
			default:
				return { kind: 'unavailable', detail: `no clipboard reader is known for ${platform}` }
		}
	} catch (err) {
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) }
	}
}

async function readLinux(
	run: CommandRunner,
	wsl: boolean,
	readText: (path: string) => string | undefined,
): Promise<ClipboardRead> {
	const tools: [string, string[]][] = [
		['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
		['wl-paste', ['--type', 'image/png']],
	]
	let toolRan = false
	for (const [file, args] of tools) {
		const result = await run(file, args, { timeoutMs: TOOL_TIMEOUT_MS })
		if (result.spawnFailed) continue
		toolRan = true
		if (result.code === 0 && isPng(result.stdout)) {
			return {
				kind: 'image',
				image: {
					data: result.stdout.toString('base64'),
					mediaType: 'image/png',
					filename: 'Pasted image',
				},
			}
		}
	}
	if (wsl) {
		// WSLg's X server rarely mirrors the Windows clipboard, so the Windows
		// side is asked even when a Linux tool ran and found nothing.
		const root = parseWslMountRoot(readText('/etc/wsl.conf'))
		const result = await runPowershell(run, powershellCandidates(root))
		if (result !== 'unresolved') return result
		if (toolRan) return { kind: 'empty' }
		return { kind: 'unavailable', detail: 'powershell.exe could not be started', wsl: true }
	}
	if (toolRan) return { kind: 'empty' }
	return { kind: 'unavailable', detail: 'install xclip (X11) or wl-clipboard (Wayland)' }
}

async function readMac(run: CommandRunner): Promise<ClipboardRead> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-clip-'))
	const file = join(dir, 'clip.png')
	try {
		const result = await run(
			'osascript',
			[
				'-e',
				'set png_data to (the clipboard as «class PNGf»)',
				'-e',
				`set fp to open for access POSIX file "${file}" with write permission`,
				'-e',
				'write png_data to fp',
				'-e',
				'close access fp',
			],
			{ timeoutMs: TOOL_TIMEOUT_MS },
		)
		if (result.spawnFailed) return { kind: 'unavailable', detail: 'osascript could not be started' }
		if (result.timedOut) return { kind: 'failed', detail: 'timed out' }
		if (result.code !== 0) return { kind: 'empty' }
		const buf = await readFile(file)
		if (!isPng(buf)) return { kind: 'empty' }
		return {
			kind: 'image',
			image: { data: buf.toString('base64'), mediaType: 'image/png', filename: 'Pasted image' },
		}
	} catch {
		return { kind: 'empty' }
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}
