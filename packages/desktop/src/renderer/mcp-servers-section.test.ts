import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { McpServersView } from '../shared/protocol.js'
import {
	type ServerDraft,
	approveLabel,
	changeFromDraft,
	draftFor,
	draftMissing,
	emptyDraft,
	mcpServerRowView,
	mcpServersNote,
	serverConfirmationCopy,
	userServerDetail,
	variablesNote,
	waitingServers,
} from './mcp-servers-model.js'
import { McpServersRows, ServerForm } from './mcp-servers-section.js'
import type { McpServersControls } from './use-mcp-servers.js'
import type { UserMcpServersControls } from './use-user-mcp-servers.js'

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
	// The row stays with no project open, and says why it is empty.
	const closed = markup(controls({ supported: false }))
	expect(closed).toContain('Tool servers')
	expect(closed).toContain('Open a project to see its servers.')
	expect(closed).not.toContain('Approve')
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

describe('adding, changing and removing the servers in your own settings', () => {
	const ownView = {
		file: '/home/me/.namzu/config.yaml',
		servers: [
			{ name: 'notes', kind: 'command' as const, command: 'notes-server', args: ['--fast'] },
			{ name: 'quiet', kind: 'address' as const, url: 'https://example.com/mcp?x=1' },
			{ name: 'odd', kind: 'other' as const },
		],
	}
	const own = (over: Partial<UserMcpServersControls> = {}): UserMcpServersControls => ({
		view: ownView,
		busy: false,
		save: vi.fn(async () => true),
		confirm: vi.fn(async () => true),
		dismiss: vi.fn(),
		remove: vi.fn(async () => true),
		open: vi.fn(async (name: string) => ownView.servers.find((s) => s.name === name)),
		clearError: vi.fn(),
		...over,
	})
	const draw = (c: McpServersControls, o?: UserMcpServersControls) =>
		renderToStaticMarkup(createElement(McpServersRows, { servers: c, own: o, projectName: 'shop' }))

	it('offers Add server, and Edit and Remove only on the servers your own settings hold', () => {
		const html = draw(controls(), own())
		expect(html).toContain('Add server')
		expect(html).toContain('aria-label="Edit notes"')
		expect(html).toContain('aria-label="Remove notes"')
		expect(html).toContain('aria-label="Remove quiet"')
		// A project's own server is approved, never edited here.
		expect(html).not.toContain('aria-label="Edit tickets"')
		expect(html).not.toContain('aria-label="Remove tickets"')
		expect(html).not.toContain('aria-label="Remove docs"')
		expect(html).toContain(
			'Variables and headers are edited in the file: /home/me/.namzu/config.yaml.',
		)
	})

	it('offers nothing to change without the bridge, as before', () => {
		const html = draw(controls())
		expect(html).not.toContain('Add server')
		expect(html).not.toContain('Variables and headers')
	})

	it('still lists and manages your own servers while no project is open', () => {
		const html = draw(controls({ supported: false }), own())
		expect(html).toContain('Open a project to see its servers.')
		for (const name of ['notes', 'quiet', 'odd']) expect(html).toContain(name)
		expect(html).toContain('notes-server')
		expect(html).toContain('https://example.com')
		expect(html).not.toContain('x=1')
		expect(html).toContain('Add server')
		// An entry the form cannot read is removed here and edited in the file.
		expect(html).not.toContain('aria-label="Edit odd"')
		expect(html).toContain('aria-label="Remove odd"')
	})

	it('words the list note for what can now be done', () => {
		expect(mcpServersNote('shop')).toContain('add, change and remove')
		expect(mcpServersNote('shop')).not.toContain('read-only')
	})
})

describe('the server form', () => {
	const draw = (draft: ServerDraft, error?: string) =>
		renderToStaticMarkup(
			createElement(ServerForm, {
				draft,
				file: '/h/config.yaml',
				error,
				onChange: () => {},
				onSave: () => {},
				onCancel: () => {},
			}),
		)

	it('asks for a name, then a command with arguments or an address, and says where variables go', () => {
		const html = draw(emptyDraft())
		expect(html).toContain('A program to run')
		expect(html).toContain('A web address')
		expect(html).toContain('Command')
		expect(html).toContain('Arguments')
		expect(html).not.toContain('Address</span>')
		expect(html).toContain('Variables and headers are edited in the file: /h/config.yaml.')
		expect(html).toContain('Add server')
		expect(html).toContain('disabled')
		// Nothing about variables or headers is a field.
		expect(html).not.toMatch(/placeholder="[^"]*(token|key|secret)/i)
	})

	it('shows the address field for an address, and fixes the name while editing', () => {
		const draft = draftFor({ name: 'quiet', kind: 'address', url: 'https://example.com/mcp' })
		const html = draw(draft)
		expect(html).toContain('value="https://example.com/mcp"')
		expect(html).toContain('readOnly')
		expect(html).toContain('Save server')
		expect(html).not.toContain('Arguments')
	})

	it('prefills a command and its arguments for an edit, and says what is wrong', () => {
		const html = draw(
			draftFor({ name: 'notes', kind: 'command', command: 'run', args: ['--fast'] }),
			'There is no server called notes here.',
		)
		expect(html).toContain('value="run"')
		expect(html).toContain('--fast')
		expect(html).toContain('There is no server called notes here.')
	})
})

describe('what the form sends', () => {
	it('sends a command with its arguments, or an address, never both', () => {
		expect(
			changeFromDraft({
				mode: 'add',
				name: ' notes ',
				kind: 'command',
				command: ' npx ',
				args: ['-y'],
				url: 'https://ignored.example.com',
			}),
		).toEqual({ mode: 'add', name: 'notes', command: 'npx', args: ['-y'] })
		expect(
			changeFromDraft({
				mode: 'edit',
				name: 'r',
				kind: 'address',
				command: 'ignored',
				args: ['x'],
				url: ' https://e.com/mcp ',
			}),
		).toEqual({ mode: 'edit', name: 'r', url: 'https://e.com/mcp' })
		expect(changeFromDraft({ ...emptyDraft(), name: 'n', command: 'run' })).toEqual({
			mode: 'add',
			name: 'n',
			command: 'run',
		})
	})

	it('says what is missing before anything is sent', () => {
		expect(draftMissing(emptyDraft())).toBe('Name the server.')
		expect(draftMissing({ ...emptyDraft(), name: 'n' })).toBe('Enter the command to run.')
		expect(draftMissing({ ...emptyDraft(), name: 'n', kind: 'address' })).toBe(
			'Enter the server’s address.',
		)
		expect(draftMissing({ ...emptyDraft(), name: 'n', command: 'x' })).toBeUndefined()
	})

	it('words the detail of a server and the question about its command', () => {
		expect(userServerDetail({ name: 'a', kind: 'command', command: 'run' })).toBe('run')
		expect(userServerDetail({ name: 'a', kind: 'address', url: 'https://e.com/p?t=1' })).toBe(
			'https://e.com',
		)
		expect(userServerDetail({ name: 'a', kind: 'other' })).toBeUndefined()
		expect(serverConfirmationCopy('Q').description).toBe('Q')
		expect(variablesNote(undefined)).toBe('Variables and headers are edited in the file.')
	})
})

describe('the ask to add a connector', () => {
	it('is taken once, so one ask opens one form', async () => {
		const { requestAddConnector, takeAddConnector } = await import('./mcp-servers-model.js')
		expect(takeAddConnector()).toBe(false)
		requestAddConnector()
		expect(takeAddConnector()).toBe(true)
		expect(takeAddConnector()).toBe(false)
	})
})
