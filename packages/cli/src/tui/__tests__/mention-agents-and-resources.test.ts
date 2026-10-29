import { describe, expect, it } from 'vitest'

import { mentionSourcesFrom } from '../mention-sources.js'
import {
	type MentionExtra,
	activeFileMention,
	attachMentionedResources,
	expandFileMentions,
	matchMentionSuggestions,
} from '../mentions.js'

const sources = mentionSourcesFrom(
	[{ name: 'reviewer', description: 'Reviews a change for mistakes' }],
	[{ server: 'docs', uri: 'docs://guide?v=2', name: 'guide', description: 'The setup guide' }],
)
const none = () => null

describe('the @ picker rows', () => {
	it('offers sub-agents and resources beside files, best match first', () => {
		const rows = matchMentionSuggestions('rev', ['src/review.ts'], sources.extras)
		expect(rows.map((row) => [row.kind, row.label])).toEqual([
			['file', 'src/review.ts'],
			['agent', 'reviewer (agent)'],
		])
	})

	it('writes an agent as a quoted token and a resource with its address quoted when it needs it', () => {
		const rows = matchMentionSuggestions('', [], sources.extras)
		const agent = rows.find((row) => row.label === 'reviewer (agent)')
		const resource = rows.find((row) => row.kind === 'resource')
		expect(agent?.insert).toBe('@"reviewer (agent)"')
		expect(resource?.insert).toBe('@"docs:docs://guide?v=2"')
		expect(resource?.description).toBe('The setup guide')
	})

	it('matches a resource by the part after the server name', () => {
		const rows = matchMentionSuggestions('guide', [], sources.extras)
		expect(rows.map((row) => row.kind)).toEqual(['resource'])
	})

	it('keeps some agents and resources in the list when nothing is typed yet', () => {
		const files = Array.from({ length: 200 }, (_, i) => `f${i}.ts`)
		const rows = matchMentionSuggestions('', files, sources.extras, 100)
		expect(rows).toHaveLength(100)
		expect(rows.some((row) => row.kind === 'agent')).toBe(true)
		expect(rows.some((row) => row.kind === 'resource')).toBe(true)
		expect(rows[0]?.kind).toBe('file')
	})

	it('skips a label that cannot be written inside a quoted mention', () => {
		const bad: MentionExtra = { kind: 'resource', label: 'docs:has"quote' }
		expect(matchMentionSuggestions('docs', [], [bad])).toEqual([])
	})

	it('finds the quoted token being typed for an agent', () => {
		expect(activeFileMention('ask @"rev', 9)?.query).toBe('rev')
	})
})

describe('sending a message that names an agent or a resource', () => {
	it('points the model at a mentioned agent, written either way, once', () => {
		const out = expandFileMentions(
			'let @"reviewer (agent)" look, then @agent-reviewer again',
			'/repo',
			none,
			sources.known,
		)
		expect(out.agents).toEqual(['reviewer'])
		expect(out.attached).toEqual([])
		expect(out.inlined).toContain('<mentioned-agent name="reviewer">')
		expect(out.inlined).toContain('subagent_type "reviewer"')
	})

	it('treats a name that is not a known agent as a file path', () => {
		const out = expandFileMentions(
			'see @agent-ghost.ts',
			'/repo',
			(rel) => (rel === 'agent-ghost.ts' ? 'x' : null),
			sources.known,
		)
		expect(out.agents).toBeUndefined()
		expect(out.attached).toEqual(['agent-ghost.ts'])
	})

	it('collects a mentioned resource of a connected server and leaves other colon paths to files', () => {
		const out = expandFileMentions(
			'read @"docs:docs://guide?v=2" and @C:/notes.txt',
			'/repo',
			(rel) => (rel === 'C:/notes.txt' ? 'n' : null),
			sources.known,
		)
		expect(out.resources).toEqual([{ server: 'docs', uri: 'docs://guide?v=2' }])
		expect(out.attached).toEqual(['C:/notes.txt'])
	})

	it('reads the resource and adds it beside the file contents, marked as remote text', async () => {
		const text = 'read @"docs:docs://guide?v=2"'
		const expanded = expandFileMentions(text, '/repo', none, sources.known)
		const out = await attachMentionedResources(expanded, text, async (server, uri) =>
			server === 'docs' ? `body of ${uri}` : null,
		)
		expect(out.attached).toEqual(['docs:docs://guide?v=2'])
		expect(out.sendText.startsWith(text)).toBe(true)
		expect(out.inlined).toMatch(
			/<resource-[0-9a-f]{12} server="docs" uri="docs:\/\/guide\?v=2">\nbody of docs:\/\/guide\?v=2\n<\/resource-/,
		)
		expect(out.inlined).toContain('came from the tool server')
	})

	it('goes on without a resource that cannot be read', async () => {
		const text = 'read @"docs:docs://guide?v=2"'
		const expanded = expandFileMentions(text, '/repo', none, sources.known)
		const out = await attachMentionedResources(expanded, text, async () => {
			throw new Error('gone')
		})
		expect(out).toBe(expanded)
	})

	it('cuts a long resource at the cap', async () => {
		const text = 'read @"docs:docs://guide?v=2"'
		const expanded = expandFileMentions(text, '/repo', none, sources.known)
		const out = await attachMentionedResources(expanded, text, async () => 'x'.repeat(50), 10)
		expect(out.inlined).toContain(`${'x'.repeat(10)}\n… (truncated)`)
	})
})
