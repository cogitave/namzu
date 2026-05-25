/**
 * `@file` mentions in a composed message. Typing `@src/auth.ts` inlines that
 * file's contents into the text sent to the model (Claude Code / opencode
 * style), while the visible message keeps the readable `@path` token.
 *
 * Safety: only files resolving *inside* the working directory are inlined
 * (so `@/etc/passwd` or `@../secrets` are ignored, not exfiltrated), and each
 * file is capped so a huge file can't blow up the turn. Non-existent or
 * unreadable tokens are left as literal text.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Path-ish characters only, so `@a.ts,` or `@a.ts)` don't swallow punctuation. */
const MENTION = /@([\w./~-]+)/g

const MAX_FILE_CHARS = 60_000

export interface ExpandedMessage {
	/** Text to send to the model (original + inlined `<file>` blocks). */
	readonly sendText: string
	/** Relative paths that were inlined (for a UI affordance). */
	readonly attached: readonly string[]
}

/**
 * Expand `@path` tokens in `text`. `readFile` is injectable for tests; the
 * default reads from disk, scoped to `cwd` and size-capped.
 */
export function expandFileMentions(
	text: string,
	cwd: string,
	readFile: (relPath: string) => string | null = (rel) => safeReadInCwd(cwd, rel),
): ExpandedMessage {
	const tokens = text.match(MENTION)
	if (!tokens) return { sendText: text, attached: [] }
	const attached: string[] = []
	const blocks: string[] = []
	const seen = new Set<string>()
	for (const tok of tokens) {
		// Drop trailing sentence punctuation the path-char class still captured
		// (e.g. the final `.` in "see @b.ts.").
		const rel = tok.slice(1).replace(/[.,;:!?]+$/, '')
		if (rel.length === 0 || seen.has(rel)) continue
		seen.add(rel)
		const content = readFile(rel)
		if (content === null) continue
		blocks.push(`<file path="${rel}">\n${content}\n</file>`)
		attached.push(rel)
	}
	if (blocks.length === 0) return { sendText: text, attached: [] }
	return { sendText: `${text}\n\n${blocks.join('\n\n')}`, attached }
}

function safeReadInCwd(cwd: string, rel: string): string | null {
	const root = resolve(cwd)
	const abs = resolve(root, rel)
	if (abs !== root && !abs.startsWith(root + sep)) return null
	try {
		if (!statSync(abs).isFile()) return null
		const raw = readFileSync(abs, 'utf8')
		return raw.length > MAX_FILE_CHARS ? `${raw.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : raw
	} catch {
		return null
	}
}
