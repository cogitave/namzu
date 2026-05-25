/**
 * Read an image off the system clipboard, for the composer's Ctrl+V paste.
 *
 * Terminals don't deliver pasted image bytes over stdin, so we shell out to
 * the platform clipboard tool, write the image to a temp PNG, and read it
 * back as base64. macOS uses `osascript` (`«class PNGf»`); Linux tries
 * `xclip` then `wl-paste`; Windows uses PowerShell. Non-throwing — any
 * failure (no image on the clipboard, tool missing) returns `null`.
 *
 * Pattern mirrors Claude Code's `utils/imagePaste.ts` clipboard plumbing.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { platform } from 'node:os'
import { join } from 'node:path'

export interface ClipboardImage {
	/** Base64-encoded PNG bytes (no `data:` prefix). */
	readonly data: string
	readonly mediaType: 'image/png'
}

const TIMEOUT_MS = 5_000

export function readClipboardImage(): ClipboardImage | null {
	const file = join(tmpdir(), `namzu-clip-${Date.now()}.png`)
	try {
		if (!saveClipboardImageTo(file)) return null
		const buf = readFileSync(file)
		if (buf.length === 0) return null
		return { data: buf.toString('base64'), mediaType: 'image/png' }
	} catch {
		return null
	} finally {
		try {
			rmSync(file, { force: true })
		} catch {
			// best-effort cleanup
		}
	}
}

/** Write the clipboard image to `file` as PNG; return false if there's none. */
function saveClipboardImageTo(file: string): boolean {
	const run = (cmd: string, args: string[]): boolean => {
		try {
			execFileSync(cmd, args, { timeout: TIMEOUT_MS, stdio: ['ignore', 'ignore', 'ignore'] })
			return true
		} catch {
			return false
		}
	}
	const runShell = (script: string): boolean => {
		try {
			execFileSync('/bin/sh', ['-c', script], {
				timeout: TIMEOUT_MS,
				stdio: ['ignore', 'ignore', 'ignore'],
			})
			return true
		} catch {
			return false
		}
	}

	switch (platform()) {
		case 'darwin':
			return run('osascript', [
				'-e',
				'set png_data to (the clipboard as «class PNGf»)',
				'-e',
				`set fp to open for access POSIX file "${file}" with write permission`,
				'-e',
				'write png_data to fp',
				'-e',
				'close access fp',
			])
		case 'linux':
			return (
				runShell(`xclip -selection clipboard -t image/png -o > "${file}" 2>/dev/null`) ||
				runShell(`wl-paste --type image/png > "${file}" 2>/dev/null`)
			)
		case 'win32':
			return run('powershell', [
				'-NoProfile',
				'-Command',
				`$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }`,
			])
		default:
			return false
	}
}
