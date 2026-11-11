import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { McpServersView } from '../shared/protocol.js'
import {
	approveLabel,
	mcpServerRowView,
	mcpServersNote,
	waitingServers,
} from './mcp-servers-model.js'
import { McpServersRows } from './mcp-servers-section.js'
import type { McpServersControls } from './use-mcp-servers.js'

const view: McpServersView = {
	servers: [
		{ name: 'notes', origin: 'your-config', state: 'connected', detail: 'notes-server' },
		{
			name: 'tickets',
			origin: 'project-file',
			state: 'waiting',
			detail: 'node',
			fingerprint: 'f1',
		},
		{ name: 'docs', origin: 'this-project', state: 'failed', reason: 'It did not answer.' },
		{ name: 'quiet', origin: 'your-config', state: 'idle' },
	],
}
const controls = (over: Partial<McpServersControls> = {}): McpServersControls => ({
	view,
	loading: false,
	approving: false,
	supported: true,
	approve: vi.fn(async () => {}),
	...over,
})
const markup = (c: McpServersControls) =>
	renderToStaticMarkup(createElement(McpServersRows, { servers: c, projectName: 'shop' }))

it('names where each server is defined and its state in plain words', () => {
	expect(mcpServerRowView(view.servers[0] as never)).toMatchObject({
		where: 'Your own settings',
		stateLabel: 'Connected',
		detail: 'notes-server',
	})
	expect(mcpServerRowView(view.servers[1] as never)).toMatchObject({
		where: '.mcp.json in this project',
		stateLabel: 'Waiting for your approval',
	})
	expect(mcpServerRowView(view.servers[2] as never)).toMatchObject({
		where: 'This project’s settings',
		stateLabel: 'Failed',
		reason: 'It did not answer.',
	})
	expect(mcpServerRowView(view.servers[3] as never).stateLabel).toBe('Not connected right now')
})

it('lists every server read-only, with the failure reason and the approval for waiting ones', () => {
	const html = markup(controls())
	for (const text of ['notes', 'tickets', 'docs', 'quiet', 'It did not answer.', 'Connected'])
		expect(html).toContain(text)
	expect(html).toContain('waiting for your approval')
	expect(html).toContain('Approve this server')
	expect(html).not.toContain('Not set')
	expect(html).not.toContain('<textarea')
	expect(html).toContain('The tool servers for “shop”.')
})

it('offers no approval when nothing waits, and says so when nothing is set up', () => {
	const none = markup(controls({ view: { servers: [view.servers[0] as never] } }))
	expect(none).not.toContain('Approve')
	const empty = markup(controls({ view: { servers: [] } }))
	expect(empty).toContain('No tool servers are set up for this project.')
	expect(markup(controls({ supported: false }))).toBe('')
})

it('says why the settings could not be read, and counts waiting servers for the button', () => {
	expect(
		markup(controls({ view: { servers: [], error: 'The .mcp.json is not valid.' } })),
	).toContain('The .mcp.json is not valid.')
	expect(waitingServers(view)).toEqual([{ name: 'tickets', fingerprint: 'f1' }])
	expect(
		waitingServers({ servers: [{ name: 'x', origin: 'project-file', state: 'waiting' }] }),
	).toEqual([])
	expect(approveLabel(3)).toBe('Approve these 3 servers')
	expect(mcpServersNote(undefined)).toContain('the open project')
})
