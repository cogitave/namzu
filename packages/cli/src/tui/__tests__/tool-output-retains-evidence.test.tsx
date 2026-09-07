import { afterEach, expect, it, vi } from 'vitest'

import { type RunEvent, type RunId, ToolRegistry, createToolPresenter } from '@namzu/sdk'

import { Transcript, renderedDetailLines, willCollapse } from '../Transcript.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import { toAgentEvent } from '../agent.js'
import { estimateRenderedLines } from '../live-window.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const presenter = createToolPresenter(new ToolRegistry())
const runId = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as RunId
const LONG_LINE = `${'x'.repeat(400)}FIRST_LINE_END`
const OUTPUT = [
	LONG_LINE,
	...Array.from({ length: 239 }, (_, i) => (i === 220 ? 'MIDDLE_DIAGNOSTIC' : `evidence-${i}`)),
	'FINAL_DIAGNOSTIC',
].join('\n')

function completed(result: string) {
	const event = toAgentEvent(
		{
			type: 'tool_completed',
			runId,
			toolUseId: 'receipt',
			toolName: 'remote_tool',
			isError: false,
			result,
		} as RunEvent,
		presenter,
	)
	if (event?.kind !== 'tool-end') throw new Error('missing completion')
	return event
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../agent.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../agent.js')>()),
	probeAgentSession: async () => ({
		preferences: { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } },
		needsRepickReason: null,
		detected: [],
	}),
	createAgentSession: async () =>
		fakeAgentSession({
			send: async function* () {
				yield {
					kind: 'tool-start',
					runId,
					toolUseId: 'receipt',
					toolName: 'remote_tool',
					summary: 'inspect output',
				}
				yield completed(OUTPUT)
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
}))

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

it.each([LONG_LINE, OUTPUT])(
	'keeps the complete first line and final diagnostic for expansion',
	(output) => {
		const event = completed(output)
		expect(event.summary.length).toBeLessThanOrEqual(120)
		expect(event.detail?.join('\n')).toBe(output)
	},
)

it('bounds a single long-line preview and offers expansion without losing its suffix', async () => {
	const event = completed(LONG_LINE)
	const message: TranscriptMessage = {
		id: 'one',
		role: 'tool',
		content: event.summary,
		detail: event.detail,
		detailRef: 1,
	}
	expect(willCollapse(message.detail)).toBe(true)
	const screen = await renderToScreen(
		<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols: 80, rows: 30 },
	)
	screens.push(screen)
	await screen.waitForRender()
	expect(screen.scrollback().join('\n')).toContain('ctrl+o')
	expect(screen.scrollback().join('\n')).not.toContain('FIRST_LINE_END')
	expect(renderedDetailLines(message).join('\n').length).toBeLessThan(350)
	screen.rerender(
		<Transcript
			messages={[{ ...message, detailExpanded: true }]}
			pending={null}
			state="idle"
			settled={0}
			resetKey={0}
		/>,
	)
	await screen.waitForRender()
	expect(screen.scrollback().join('\n')).toContain('FIRST_LINE_END')
})

it.each([40, 80])(
	'bounds both fragments and exposes terminal controls at %i columns',
	async (cols) => {
		const detail = Object.freeze([
			`HEAD ${'x'.repeat(300)}FIRST_END`,
			'second',
			'third',
			...Array.from({ length: 200 }, (_, i) => `middle-${i}`),
			`TAIL \u001b[2J${'😀'.repeat(160)}TAIL_END`,
			'penultimate',
			'FINAL_DIAGNOSTIC',
		])
		const message: TranscriptMessage = {
			id: 'fragments',
			role: 'tool',
			content: 'Preview anchor',
			detail,
			detailRef: 1,
		}
		const projected = renderedDetailLines(message)
		expect(projected).toHaveLength(7)
		expect(projected[3]).toBe('   … 200 lines omitted · ctrl+o · shortened preview')
		expect(projected.every((line) => line.length <= 243)).toBe(true)
		expect(projected.join('\n')).not.toMatch(/\p{Surrogate}/u)
		const screen = await renderToScreen(
			<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
			{ cols, rows: 80 },
		)
		screens.push(screen)
		const visible = screen.viewport().filter((line) => line.trim())
		const text = visible.join('\n')
		expect(text).toContain('Preview anchor')
		expect(text).toContain('HEAD ')
		expect(text).toContain('TAIL \\u{001b}[2J')
		expect(text).toContain('FINAL_DIAGNOSTIC')
		expect(text).not.toContain('middle-')
		expect(text).not.toContain('FIRST_END')
		expect(text).not.toContain('TAIL_END')
		expect(estimateRenderedLines(projected, cols)).toBeGreaterThanOrEqual(visible.length - 1)
		expect(renderedDetailLines({ ...message, detailExpanded: true })).toHaveLength(detail.length)
		expect(message.detail).toBe(detail)
	},
)

async function until(screen: Screen, predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await screen.waitForRender()
	expect(predicate()).toBe(true)
}

it.each(['\u000f', '/raw'])(
	'shows the final diagnostic immediately and recovers omitted output through the App with %s',
	async (command) => {
		const { App } = await import('../App.js')
		const screen = await renderToScreen(<App ctx={{ cwd: '/work', version: 'test' }} />, {
			cols: 100,
			rows: 40,
			scrollback: 1000,
		})
		screens.push(screen)
		const text = () => screen.scrollback().join('\n')
		await until(screen, () => text().includes('mock-model default'))
		screen.press('inspect')
		await screen.waitForRender()
		screen.press('\r')
		await until(screen, () => text().includes('ctrl+o'))
		expect(text()).toContain('FINAL_DIAGNOSTIC')
		expect(text()).toContain('235 lines omitted')
		expect(text()).not.toContain('MIDDLE_DIAGNOSTIC')
		screen.press(command)
		await screen.waitForRender()
		if (command.startsWith('/')) screen.press('\r')
		await until(screen, () => text().includes('MIDDLE_DIAGNOSTIC'))
		expect(text()).toContain('FIRST_LINE_END')
		const restored = text()
			.split('\n')
			.map((line) => line.replace(/^\s*(?:▏\s*)?/, ''))
		expect(restored).toEqual(expect.arrayContaining(OUTPUT.split('\n').slice(1)))
	},
)
