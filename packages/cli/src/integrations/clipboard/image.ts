/**
 * Read an image off the system clipboard, for the composer's Ctrl+V paste.
 *
 * Terminals don't deliver pasted image bytes over stdin, so we shell out to
 * the platform clipboard tool, write the image to a temp PNG, and read it
 * back as base64. macOS uses `osascript` (`«class PNGf»`); Linux tries
 * `xclip` then `wl-paste`; Windows uses PowerShell. Non-throwing — every
 * failure comes back as a {@link ClipboardRead} saying which failure it was,
 * so the composer can tell the operator something other than nothing.
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

/**
 * What a clipboard read found, and when it found nothing, why.
 *
 * The reason is the whole point of this type. A single `null` for every outcome
 * left the composer with nothing to say, so `Ctrl+V` with no image behaved
 * exactly like `Ctrl+V` on a machine with no clipboard tool installed, which in
 * turn behaved exactly like a key that was never wired up. Three quite
 * different situations, one silence — and the operator's next move differs in
 * each: copy an image, install a tool, or stop pressing the key.
 */
export type ClipboardRead =
	| { readonly kind: 'image'; readonly image: ClipboardImage }
	/** A tool ran and the clipboard held no image. */
	| { readonly kind: 'empty' }
	/** Nothing on this machine can read an image off the clipboard. */
	| { readonly kind: 'unavailable'; readonly detail: string }

const TIMEOUT_MS = 5_000

export function readClipboardImage(): ClipboardRead {
	const unavailable = clipboardUnavailable()
	if (unavailable !== null) return { kind: 'unavailable', detail: unavailable }
	const file = join(tmpdir(), `namzu-clip-${Date.now()}.png`)
	try {
		if (!saveClipboardImageTo(file)) return { kind: 'empty' }
		const buf = readFileSync(file)
		if (buf.length === 0) return { kind: 'empty' }
		return { kind: 'image', image: { data: buf.toString('base64'), mediaType: 'image/png' } }
	} catch {
		return { kind: 'empty' }
	} finally {
		try {
			rmSync(file, { force: true })
		} catch {
			// best-effort cleanup
		}
	}
}

/**
 * Why this machine cannot read a clipboard image at all, or `null` if it can.
 *
 * Checked before attempting the read, because afterwards the two are
 * indistinguishable: a missing `xclip` and an empty clipboard both come back
 * from `/bin/sh` as a non-zero exit. The macOS and Windows tools ship with the
 * OS, so only Linux needs the probe.
 */
function clipboardUnavailable(): string | null {
	switch (platform()) {
		case 'darwin':
		case 'win32':
			return null
		case 'linux': {
			try {
				execFileSync('/bin/sh', ['-c', 'command -v xclip || command -v wl-paste'], {
					timeout: TIMEOUT_MS,
					stdio: ['ignore', 'ignore', 'ignore'],
				})
				return null
			} catch {
				return 'install xclip (X11) or wl-clipboard (Wayland)'
			}
		}
		default:
			return `no clipboard reader is known for ${platform()}`
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
