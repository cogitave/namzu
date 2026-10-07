import type { ChatMessage, ConversationView, DesktopEvent } from '../shared/protocol.js'

// A long conversation and a timer-driven streamed reply for measuring the transcript in a real
// browser. Reached only through /preview?stress=<turns>; nothing here runs otherwise.
export const stressConversationId = 'sample-stress'

const snippets = [
	'```ts\nexport function total(items: { price: number; count: number }[]): number {\n\tlet sum = 0\n\tfor (const item of items) sum += item.price * item.count\n\treturn sum\n}\n```',
	'```sh\npnpm --filter @namzu/desktop test -- src/renderer\npnpm typecheck\n```',
]
const lists = [
	'- Keep the settled blocks stable.\n- Re-parse only the tail.\n- Measure in a real browser, not in Node.',
	'1. Read the neighbouring code.\n2. Change one thing.\n3. Run the scoped tests.',
]
const table =
	'| Step | Cost | Note |\n| --- | --- | --- |\n| Parse | 4 ms | grows with length |\n| Render | 7 ms | per block |'

/** One reply: paragraphs, a list, a fence and a table, about 1.3 KB. */
export function stressReply(index: number): string {
	return [
		`### Turn ${index + 1}: what changed`,
		`The change to **module ${index % 17}** keeps the *existing* behaviour and adds a [reference](https://example.test/turn/${index}) for \`src/rail.css:3\`. It reads the notes first, then applies the smallest edit that works, and checks it with the scoped tests before moving on.`,
		lists[index % lists.length] ?? '',
		snippets[index % snippets.length] ?? '',
		'A second paragraph explains why the earlier approach was dropped: it re-rendered everything on every update, which is invisible in a short reply and obvious in a long one.',
		table,
	].join('\n\n')
}

export function stressMessages(turns: number): ChatMessage[] {
	const result: ChatMessage[] = []
	for (let index = 0; index < turns; index++) {
		result.push({
			role: 'user',
			text: `Question ${index + 1}: apply the next change and explain it.`,
		})
		result.push({ role: 'assistant', text: stressReply(index), status: 'completed' })
	}
	return result
}

/** A long reply that ends mid-structure often, as a model's does. */
export function longStreamingReply(paragraphs: number): string {
	const parts: string[] = []
	for (let index = 0; index < paragraphs; index++) parts.push(stressReply(index + 1000))
	return parts.join('\n\n')
}

export interface StressStream {
	start(options?: { paragraphs?: number; chunkChars?: number; intervalMs?: number }): Promise<void>
}

/** The timer is the only clock: one chunk per interval, then the turn settles and is saved. */
export function createStressStream(
	view: ConversationView,
	emit: (event: DesktopEvent) => void,
	saved: ChatMessage[],
): StressStream {
	return {
		start({ paragraphs = 12, chunkChars = 24, intervalMs = 16 } = {}) {
			const prompt = 'Stream a long answer.'
			const reply = longStreamingReply(paragraphs)
			emit({ kind: 'prompt', sessionId: view.id, prompt })
			emit({ kind: 'state', sessionId: view.id, running: true, queued: [] })
			let at = 0
			return new Promise((resolve) => {
				const timer = setInterval(() => {
					const text = reply.slice(at, at + chunkChars)
					at += chunkChars
					if (text)
						emit({
							kind: 'update',
							projectId: view.projectId,
							sessionId: view.id,
							update: { kind: 'agent_message_chunk', text },
						})
					if (at < reply.length) return
					clearInterval(timer)
					saved.push({ role: 'user', text: prompt }, { role: 'assistant', text: reply })
					emit({ kind: 'state', sessionId: view.id, running: false, queued: [] })
					resolve()
				}, intervalMs)
			})
		},
	}
}
