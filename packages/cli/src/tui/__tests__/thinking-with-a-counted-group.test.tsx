/**
 * Reasoning is drawn above the row it led to. A counted line of reads takes the
 * reasoning that came before it, so the detailed transcript does not hang it
 * under the answer that followed.
 */

import { render } from 'ink-testing-library'
import { useRef, useState } from 'react'
import { expect, it } from 'vitest'

import { TranscriptScreen } from '../TranscriptScreen.js'
import type { TranscriptMessage } from '../types.js'
import { type ReadSearchGroupControls, useReadSearchGroup } from '../useReadSearchGroup.js'

interface Handle {
	think(text: string): void
	read(key: string, path: string): void
	answer(text: string): void
	close(): void
}

function Probe({ handle }: { handle: { current: Handle | null } }) {
	const [messages, setMessages] = useState<readonly TranscriptMessage[]>([])
	const thinking = useRef('')
	const counter = useRef(0)
	const nextId = () => `m${++counter.current}`
	const group: ReadSearchGroupControls = useReadSearchGroup(setMessages, nextId, () => {
		const text = thinking.current
		if (text.trim() === '') return undefined
		thinking.current = ''
		return text
	})
	handle.current = {
		think: (text) => {
			thinking.current += text
		},
		read: (key, path) => group.start(key, { kind: 'read', key: path }),
		answer: (text) => {
			group.close()
			const taken = thinking.current
			thinking.current = ''
			setMessages((prev) => [
				...prev,
				{
					id: nextId(),
					role: 'assistant',
					content: text,
					...(taken.trim() !== '' ? { thinking: taken } : {}),
				},
			])
		},
		close: () => group.close(),
	}
	return (
		<TranscriptScreen
			messages={messages}
			pending={null}
			rows={400}
			columns={100}
			dialogWaiting={false}
			onClose={() => {}}
		/>
	)
}

it('draws each thinking block above the row it led to', async () => {
	const handle: { current: Handle | null } = { current: null }
	const view = render(<Probe handle={handle} />)
	const act = async (step: () => void) => {
		step()
		for (let turn = 0; turn < 8; turn++) await new Promise<void>((r) => setImmediate(r))
	}
	await act(() => handle.current?.think('first-thought'))
	await act(() => handle.current?.read('t:1', 'a.ts'))
	await act(() => handle.current?.think('second-thought'))
	await act(() => handle.current?.read('t:2', 'b.ts'))
	await act(() => handle.current?.close())
	await act(() => handle.current?.think('final-thought'))
	await act(() => handle.current?.answer('the-answer'))
	const frame = view.lastFrame() ?? ''
	view.unmount()
	const at = (needle: string) => {
		const i = frame.indexOf(needle)
		expect(i, `${needle} should be on the screen`).toBeGreaterThanOrEqual(0)
		return i
	}
	const groupAt = at('Read 2 files')
	expect(at('first-thought')).toBeLessThan(groupAt)
	expect(at('second-thought')).toBeLessThan(groupAt)
	expect(at('final-thought')).toBeGreaterThan(groupAt)
	expect(at('final-thought')).toBeLessThan(at('the-answer'))
})
