/**
 * Read text off the system clipboard.
 *
 * The paste key reads an image first. A terminal that hands the key to the
 * application instead of pasting has swallowed the text paste as well, so when
 * there is no image the key falls back to the clipboard's text and inserts it,
 * which is what the operator pressed the key to get.
 *
 * Every read is bounded by a short timeout: a clipboard that cannot answer
 * must never hold the composer up. Non-throwing: any failure is `null`.
 */

import { type CommandRunner, powershellCandidates, runCommand } from './image.js'
import { isWslEnv, parseWslMountRoot, readTextOrUndefined } from './wsl.js'

/** How long a text read may take before it is abandoned. */
export const TEXT_READ_TIMEOUT_MS = 2_000

const GARBAGE_SAMPLE = 4096
const GARBAGE_RATIO = 0.05

/**
 * Whether text is really binary data read through a text channel: it holds a
 * NUL, or more than 5% of its first 4096 characters are U+FFFD.
 */
export function looksLikeBinary(text: string): boolean {
	if (text.includes('\0')) return true
	const sample = text.slice(0, GARBAGE_SAMPLE)
	if (sample.length === 0) return false
	let replacement = 0
	for (const char of sample) if (char === '\uFFFD') replacement += 1
	return replacement / sample.length > GARBAGE_RATIO
}

const POWERSHELL_TEXT_ARGS = [
	'-NoProfile',
	'-NonInteractive',
	'-Command',
	'[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw',
]

export interface TextReadDeps {
	readonly platform?: NodeJS.Platform
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly run?: CommandRunner
	readonly readText?: (path: string) => string | undefined
}

/** The clipboard's text, or `null` when there is none, it is binary, or it cannot be read. */
export async function readClipboardText(deps: TextReadDeps = {}): Promise<string | null> {
	const platform = deps.platform ?? process.platform
	const env = deps.env ?? process.env
	const run = deps.run ?? runCommand
	const readText = deps.readText ?? readTextOrUndefined
	const attempts: [string, readonly string[]][] = []
	if (platform === 'darwin') {
		attempts.push(['pbpaste', []])
	} else if (platform === 'win32') {
		attempts.push(['powershell', POWERSHELL_TEXT_ARGS])
	} else if (isWslEnv({ platform, env, readText })) {
		const root = parseWslMountRoot(readText('/etc/wsl.conf'))
		for (const file of powershellCandidates(root)) attempts.push([file, POWERSHELL_TEXT_ARGS])
	} else {
		attempts.push(['xclip', ['-selection', 'clipboard', '-o']])
		attempts.push(['wl-paste', ['--no-newline']])
	}
	try {
		for (const [file, args] of attempts) {
			const result = await run(file, args, { timeoutMs: TEXT_READ_TIMEOUT_MS })
			if (result.spawnFailed) continue
			if (result.timedOut) return null
			// A PowerShell that ran and failed would fail again at its other paths.
			if (result.code !== 0) {
				if (file.toLowerCase().includes('powershell')) return null
				continue
			}
			const text = result.stdout.toString('utf8')
			return text.length === 0 || looksLikeBinary(text) ? null : text
		}
	} catch {
		return null
	}
	return null
}
