/**
 * A table arriving row by row is drawn as the table it is from the moment its
 * separator arrives, at every width: no raw `| a | b |` source row, and no
 * half-typed row left below the box as a paragraph.
 */

import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { splitSafeCut } from '../stream-blocks.js'
import { Transcript } from '../Transcript.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

const REPLY = [
	'Net stack',
	'',
	'| Katman | Kullanılan yapı |',
	'|---|---|',
	'| **Agent core** | `@openclaw/agent-core` — agent loop ve oturum sözleşmeleri |',
	'| LLM çekirdeği | `@openclaw/llm-core` — model, mesaj ve sağlayıcı katmanı |',
].join('\n')

async function draw(content: string, cols: number): Promise<string[]> {
	const pending: TranscriptMessage = { id: 'reply', role: 'assistant', content, pending: true }
	await mounted?.unmount()
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript messages={[]} pending={pending} state="thinking" settled={0} resetKey={0} staticIndent={1} />
		</Box>,
		{ cols, rows: 40 },
	)
	return mounted.viewport()
}

it.each([160, 120, 80, 40])('never shows a table row as source while it streams, at %i columns', async (cols) => {
	// Every prefix the stream could release, as the release rule releases it.
	let shown = ''
	let buffer = ''
	for (const char of REPLY) {
		buffer += char
		const { ready, rest } = splitSafeCut(buffer)
		if (ready.length === 0) continue
		shown += ready
		buffer = rest
		const lines = await draw(shown, cols)
		for (const line of lines) expect(line.trimStart().startsWith('|')).toBe(false)
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(cols)
	}
	const final = await draw(REPLY, cols)
	const text = final.join('\n')
	expect(text).toContain('Katman')
	expect(text).toContain('@openclaw/llm-core')
	expect(text).not.toMatch(/\*\*|`/)
})
