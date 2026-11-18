import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A person never reads these words in a sentence the app shows. The files below own sentences
 * that reach the screen (errors, tool rows, approvals, the turn-end line, the context ring,
 * update and voice messages, the native boxes); every quoted sentence in them is read against the
 * list. A sentence that has to carry one of the words, because it is matched rather than shown,
 * goes in ALLOWED with the reason.
 */
const STOP_WORDS =
	/\b(?:sessions?|ACP|protocol|LLM|credentials?|exit codes?|tokens?|MCP|admitted|mailbox)\b/i

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')

const OWNED = [
	'shared/plain-error.ts',
	'renderer/friendly-errors.ts',
	'renderer/approval-card-model.ts',
	'renderer/context-ring.ts',
	'renderer/model-facts.ts',
	'renderer/turn-result-model.ts',
	'renderer/tool-transcript-presentation.ts',
	'renderer/terminal-pane.tsx',
	'renderer/undo-model.ts',
	'renderer/engine-delivery-model.ts',
	'main/native-failure.ts',
	'main/kernel/check.ts',
	'main/local-speech.ts',
	'main/updater.ts',
	'main/engine-updates.ts',
]

/** Sentences matched, not shown: the provider's own words, kept for Details. */
const ALLOWED = new Set([
	'the provider rejected the request credentials',
	'No usage was reported for the failed attempts.',
])

/** Quoted strings that read as a sentence: a capital letter first, and at least two words. */
function sentences(whole: string): string[] {
	// Comments are for developers; only code is read.
	const source = whole.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1')
	const found: string[] = []
	for (const match of source.matchAll(
		/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g,
	)) {
		const text = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, '')
		if (/^[A-Z“‘][^\n]*\s\S/.test(text)) found.push(text)
	}
	return found
}

describe('the words a person reads', () => {
	it('catches a sentence that carries one', () => {
		const found = sentences(
			"throw new Error('No LLM provider is available on this machine.') // not a session",
		)
		expect(found).toEqual(['No LLM provider is available on this machine.'])
		expect(STOP_WORDS.test(found[0] ?? '')).toBe(true)
	})
	for (const file of OWNED)
		it(`${file} says none of the stop words`, () => {
			const found = sentences(readFileSync(join(SRC, file), 'utf8'))
			// The scan must see the file's sentences, or an empty list proves nothing.
			expect(found.length).toBeGreaterThan(0)
			expect(found.filter((text) => STOP_WORDS.test(text) && !ALLOWED.has(text))).toEqual([])
		})
	it('the engine sentences Desktop maps by code are free of them too', async () => {
		const { ENGINE_CODE_SENTENCES } = await import('./plain-error.js')
		for (const sentence of Object.values(ENGINE_CODE_SENTENCES))
			expect(sentence).not.toMatch(STOP_WORDS)
	})
})
