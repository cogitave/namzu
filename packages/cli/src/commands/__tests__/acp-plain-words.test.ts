import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/**
 * The failures the ACP host throws are shown to people by front ends that do not rewrite them, so
 * the sentence itself is plain. Every sentence passed to `engineFailure` (the coded ones) is read
 * against the words a person never sees.
 */
const STOP_WORDS =
	/\b(?:sessions?|ACP|protocol|LLM|credentials?|exit codes?|tokens?|MCP|admitted|mailbox|handshake)\b/i

it('every coded engine failure is a plain sentence with a stable code', () => {
	const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'acp.ts'), 'utf8')
	const calls = [...source.matchAll(/engineFailure\(\s*'([a-z-]+)',\s*([\s\S]*?)\)(?:\n|,\n)/g)]
	expect(calls.length).toBeGreaterThanOrEqual(8)
	const codes = new Set<string>()
	for (const [, code = '', body = ''] of calls) {
		codes.add(code)
		const sentence = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((part) => part[1]).join(' ')
		expect(sentence, code).not.toMatch(STOP_WORDS)
	}
	for (const code of [
		'no-provider',
		'connection-closed',
		'folder-not-trusted',
		'conversation-in-other-folder',
		'conversation-opening',
		'message-not-sent',
		'too-many-messages',
		'permission-mode-needed',
	])
		expect(codes.has(code), code).toBe(true)
})
