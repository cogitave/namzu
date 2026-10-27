import { afterEach, describe, expect, it } from 'vitest'

import type { SkillInfo } from '../../skills/store.js'
import { ContextGridRow } from '../ContextGridRow.js'
import { type ContextSources, collectContextView } from '../context-usage.js'
import { type Screen, renderToScreen } from './support/screen.js'

const sources = (over: Partial<ContextSources> = {}): ContextSources => ({
	context: { tokens: 42_000, windowTokens: 200_000, measured: true, windowAssumed: false },
	terminalColumns: 100,
	autoCompact: true,
	tools: [],
	messages: [],
	instructionFiles: [],
	mcpInstructions: [],
	skills: [],
	agents: [],
	displayPath: (path) => path,
	readText: async () => '',
	...over,
})

const skill = (name: string, description: string, over: Partial<SkillInfo> = {}): SkillInfo => ({
	name,
	description,
	path: `/skills/${name}/SKILL.md`,
	source: 'user',
	tier: 'user',
	...over,
})

describe('collecting the view', () => {
	it('sizes memory files one by one and shows the path a person reads', async () => {
		const view = await collectContextView(
			sources({
				instructionFiles: ['/repo/AGENTS.md', '/repo/docs/AGENTS.md'],
				displayPath: (path) => path.replace('/repo/', ''),
				readText: async (path) =>
					path.endsWith('docs/AGENTS.md') ? 'y'.repeat(80) : 'x'.repeat(400),
			}),
		)
		const memory = view.sections.find((s) => s.title === 'Memory files')
		expect(memory?.hint).toBe('/memory')
		expect(memory?.groups[0]?.items).toEqual([
			{ label: 'AGENTS.md', value: '100 tokens' },
			{ label: 'docs/AGENTS.md', value: '20 tokens' },
		])
	})

	it('splits built-in tools from a server tool and names the server tool plainly', async () => {
		const view = await collectContextView(
			sources({
				tools: [
					{ name: 'bash', tokens: 900 },
					{ name: 'mcp__tickets__create', tokens: 300, server: 'tickets' },
					{ name: 'mcp__tickets__list', tokens: 120, server: 'tickets' },
				],
			}),
		)
		const legend = view.legend.map((l) => l.name)
		expect(legend).toContain('System tools')
		expect(legend).toContain('MCP tools')
		expect(view.sections.find((s) => s.title === 'MCP tools')?.groups[0]?.items[0]).toEqual({
			label: 'tickets · create',
			value: '300 tokens',
		})
	})

	it('lists the skills the model is offered, not the ones it is not', async () => {
		const view = await collectContextView(
			sources({
				skills: [
					skill('review', 'x'.repeat(200)),
					skill('operator-only', 'hidden', { invocation: 'operator' }),
					skill('broken', 'bad', { problem: 'unreadable' }),
					skill('off', 'disabled', { disabled: true }),
					skill('tiny', 'a', { source: 'project', tier: 'project' }),
				],
			}),
		)
		const skills = view.sections.find((s) => s.title === 'Skills')
		expect(skills?.groups.map((g) => g.heading)).toEqual(['Project', 'User'])
		expect(skills?.groups[1]?.items).toEqual([{ label: 'review', value: '~50' }])
		expect(skills?.groups[0]?.items).toEqual([{ label: 'tiny', value: '< 20' }])
	})

	it('groups agents by where they live, largest first', async () => {
		const agent = (name: string, description: string, source: string) => ({
			name,
			description,
			prompt: '',
			readOnly: false,
			path: `/a/${name}.md`,
			source,
		})
		const view = await collectContextView(
			sources({
				agents: [
					agent('small', 'x', 'user'),
					agent('big', 'x'.repeat(400), 'user'),
					agent('proj', 'x', 'project'),
				],
			}),
		)
		const agents = view.sections.find((s) => s.title === 'Custom agents')
		expect(agents?.hint).toBe('.namzu/agents/')
		expect(agents?.groups.map((g) => g.heading)).toEqual(['Project', 'User'])
		expect(agents?.groups[1]?.items.map((i) => i.label)).toEqual(['big', 'small'])
	})

	it('estimates the conversation from its messages once a compaction made the reported size stale', async () => {
		const messages = [
			{ role: 'user', content: 'x'.repeat(4_000) },
			{ role: 'assistant', content: 'y'.repeat(4_000) },
		] as never
		const fresh = await collectContextView(sources({ messages }))
		const stale = await collectContextView(sources({ messages, sizeOutOfDate: true }))
		expect(fresh.text).toContain('42k/200k tokens')
		// About two thousand tokens of messages, not the 42k of the reply before the compaction.
		expect(stale.text).not.toContain('42k/200k')
		expect(stale.text).toMatch(/~\d(?:\.\d)?k\/200k tokens/)
	})

	it('carries the prompt cache lifetime through when the provider lets it be chosen', async () => {
		const view = await collectContextView(sources({ cacheLifetime: '1 hour' }))
		expect(view.cacheNote?.value).toBe('1 hour')
		expect((await collectContextView(sources())).cacheNote).toBeUndefined()
	})

	it('leaves out a list with nothing in it', async () => {
		const view = await collectContextView(sources())
		expect(view.sections).toEqual([])
		expect(view.text).toContain('42k/200k tokens (21%)')
	})
})

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

describe('the drawn view', () => {
	it('draws the grid beside the legend, then the lists', async () => {
		const view = await collectContextView(
			sources({
				systemPrompt: 'p'.repeat(8_000),
				instructionFiles: ['/repo/AGENTS.md'],
				readText: async () => 'x'.repeat(2_000),
				displayPath: () => 'AGENTS.md',
			}),
		)
		const screen = await renderToScreen(<ContextGridRow view={view} />, { cols: 100, rows: 40 })
		mounted = screen
		await screen.waitForRender()
		const text = screen.viewport().join('\n')
		expect(text).toContain('Context usage')
		expect(text).toContain('42k/200k tokens (21%)')
		expect(text).toContain('Estimated usage by category')
		expect(text).toContain('System prompt: 2k tokens (1.0%)')
		expect(text).toContain('Free space: 158k (79.0%)')
		expect(text).toContain('Memory files · /memory')
		expect(text).toContain('└ AGENTS.md: 500 tokens')
		const gridRows = screen.viewport().filter((line) => /^\s*[⛁⛀⛶⛝]( [⛁⛀⛶⛝]){9}/u.test(line))
		expect(gridRows).toHaveLength(10)
	})

	it('draws the prompt cache lifetime under the legend', async () => {
		const view = await collectContextView(sources({ cacheLifetime: '5 minutes' }))
		const screen = await renderToScreen(<ContextGridRow view={view} />, { cols: 100, rows: 40 })
		mounted = screen
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Prompt cache lifetime: 5 minutes')
	})

	it('draws a five by five grid on a narrow terminal', async () => {
		const view = await collectContextView(sources({ terminalColumns: 60 }))
		const screen = await renderToScreen(<ContextGridRow view={view} />, { cols: 60, rows: 40 })
		mounted = screen
		await screen.waitForRender()
		const gridRows = screen
			.viewport()
			.filter((line) => /^\s*[⛁⛀⛶⛝]( [⛁⛀⛶⛝]){4}(?:\s|$)/u.test(line))
		expect(gridRows).toHaveLength(5)
	})
})
