import type { RosterMachineView, RosterSession, RosterView } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
	describeAction,
	fit,
	peersActions,
	renderPeersScreen,
	renderRosterList,
	renderStatus,
	rosterJson,
} from './format.js'
import {
	type MachineRow,
	type SessionRow,
	ageWord,
	formatSessionList,
	rowsFromLocalList,
} from './session-list.js'
import type { NetworkSummary } from './types.js'

const NOW = 1_700_000_000_000

const session = (
	ref: string,
	name: string,
	folder: string,
	mode: string,
	extra: Partial<RosterSession> = {},
): RosterSession => ({
	ref,
	name,
	folder,
	state: 'idle',
	mode,
	acceptsMessages: true,
	kind: 'tui',
	...extra,
})

function fixture(desk: Partial<RosterMachineView> = {}): RosterView {
	return {
		machines: [
			{
				machineId: 'a'.repeat(64),
				name: 'studio-air',
				status: 'self',
				sessions: [
					session('aaaaaa', 'calm-heron', 'namzu', 'classify', { role: 'orchestrator' }),
					session('bbbbbb', 'quiet-otter', 'namzu', 'classify', {
						state: 'running',
						role: 'you will build the parser',
					}),
				],
			},
			{
				machineId: 'b'.repeat(64),
				name: 'desk-linux',
				status: 'online',
				seenAt: NOW,
				sessions: [
					session('cccccc', 'swift-finch', 'api-server', 'prompt'),
					session('dddddd', 'brisk-marten', 'api-server', 'classify'),
				],
				...desk,
			},
		],
	}
}

const summary = (extra: Partial<NetworkSummary> = {}): NetworkSummary => ({
	state: 'ready',
	members: 2,
	nearbyNetworks: 0,
	nearby: [],
	joinRequests: [],
	held: [],
	autoJoined: [],
	trustedNetworks: [],
	outcomes: [],
	...extra,
})

const join = {
	requestId: 'r1',
	name: 'desk-mini',
	code: '482 913',
	sourceAddr: '192.168.1.23',
	expiresAt: NOW + 8 * 60_000,
}
const remoteHeld = {
	id: 'h1',
	machineName: 'desk-linux',
	fromSessionName: 'swift-finch',
	fromMode: 'prompt',
	toSessionRef: 'aaaaaa',
	reason: 'its permission mode differs (it is in prompt, you are in auto)',
	text: 'Can you rerun the migration check on your side?',
	expiresAt: NOW + 3 * 60_000,
}

describe('namzu peers list', () => {
	it('lists every session as one counted list, the machine last, the extras on a second line', () => {
		expect(renderRosterList(fixture(), { now: NOW, selfRef: 'aaaaaa' })).toBe(
			[
				'Namzu sessions (4):',
				'  [idle]  ·  calm-heron  ·  this terminal',
				'      in namzu · auto mode',
				'      role: orchestrator',
				'  [running]  ·  quiet-otter',
				'      in namzu · auto mode',
				'      role: you will build the parser',
				'  [idle]  ·  brisk-marten  ·  desk-linux',
				'      in api-server · auto mode',
				'  [idle]  ·  swift-finch  ·  desk-linux',
				'      in api-server · prompt mode',
				'',
				'Machines (2):',
				'  [online]  ·  studio-air  ·  this machine',
				'  [online]  ·  desk-linux',
			].join('\n'),
		)
	})

	it('shows how long ago a session of this machine started, from the start times it is given', () => {
		const text = renderRosterList(fixture(), {
			now: NOW,
			selfRef: 'aaaaaa',
			startTimes: new Map([
				['aaaaaa', NOW - 7 * 60_000],
				['bbbbbb', NOW - 23_000],
				['cccccc', NOW - 1_000],
			]),
		})
		expect(text).toContain('[idle]  ·  calm-heron  ·  this terminal  ·  started 7m ago')
		expect(text).toContain('[running]  ·  quiet-otter  ·  started 23s ago')
		// another machine's session has no start time here and names its machine instead
		expect(text).toContain('[idle]  ·  swift-finch  ·  desk-linux\n')
	})

	it('shows the sessions of a machine that did not answer as offline', () => {
		const text = renderRosterList(fixture({ status: 'offline', seenAt: NOW - 5 * 60_000 }), {
			now: NOW,
		})
		expect(text).toContain('[offline]  ·  swift-finch  ·  desk-linux')
		expect(text).toContain('[offline]  ·  desk-linux  ·  last seen 5m ago')
		expect(text).not.toContain('not accepting')
		expect(
			renderRosterList(
				{
					machines: [
						{
							...fixture().machines[1],
							sessions: [],
							status: 'offline',
							seenAt: undefined,
						} as RosterMachineView,
					],
				},
				{ now: NOW },
			),
		).toBe(
			['No Namzu sessions are running.', '', 'Machines (1):', '  [offline]  ·  desk-linux'].join(
				'\n',
			),
		)
	})

	it('adds a ref only to tell two rows with one name apart', () => {
		const view = fixture()
		const twins: RosterView = {
			machines: [
				view.machines[0] as RosterMachineView,
				{
					...(view.machines[1] as RosterMachineView),
					sessions: [session('eeeeee', 'calm-heron', 'api-server', 'classify')],
				},
			],
		}
		const text = renderRosterList(twins)
		expect(text).toContain('calm-heron [aaaaaa]')
		expect(text).toContain('calm-heron [eeeeee]')
		expect(text).not.toContain('quiet-otter [')
	})

	it('gives JSON with no path, key or token, and the mode in the words a person uses', () => {
		const json = rosterJson(fixture())
		expect(json[0]).toMatchObject({ name: 'studio-air', status: 'self' })
		expect(json[0]?.sessions[0]).toMatchObject({
			name: 'calm-heron',
			ref: 'aaaaaa',
			folder: 'namzu',
			state: 'idle',
			permissionMode: 'auto',
			role: 'orchestrator',
		})
		expect(JSON.stringify(json)).not.toMatch(/token|\/home|machineId/)
	})
})

describe('the /peers screen', () => {
	const full = () =>
		renderPeersScreen({
			summary: summary({ joinRequests: [join], held: [remoteHeld] }),
			roster: fixture(),
			selfRef: 'aaaaaa',
			heldLocal: [],
			now: NOW,
			columns: 100,
		})

	it('draws who asks to join first, then the machines and what is held', () => {
		const text = full()
		expect(text.indexOf('Your Namzu network · on · 2 machines')).toBe(0)
		expect(text.indexOf('Join requests (1)')).toBeGreaterThan(0)
		expect(text.indexOf('Join requests (1)')).toBeLessThan(text.indexOf('Namzu sessions (4):'))
		expect(text).toContain('[online]  ·  studio-air  ·  this machine')
		expect(text).toContain('[idle]  ·  calm-heron  ·  this terminal')
		expect(text).toContain('[online]  ·  desk-linux')
		expect(text.indexOf('Held (1)')).toBeGreaterThan(text.indexOf('Machines (2):'))
		expect(text).toContain('desk-mini wants to join your Namzu network')
		expect(text).toContain('code 482 913')
		expect(text.replace(/\s+/g, ' ')).toContain('3 min left')
		expect(text).toContain('expires in 8 min')
		expect(text).toContain('"Can you rerun the migration check on your side?"')
	})

	it('draws no section that is empty, and says so when this machine is alone', () => {
		const text = renderPeersScreen({
			summary: summary({ members: 1 }),
			roster: { machines: [fixture().machines[0] as RosterMachineView] },
			selfRef: 'aaaaaa',
			heldLocal: [],
			now: NOW,
			columns: 100,
		})
		expect(text).toContain(
			'Only this machine so far. Other machines running Namzu on this network will appear here.',
		)
		expect(text).not.toContain('Held')
		expect(text).not.toContain('Join requests')
	})

	it('shows a machine that did not answer with how long ago it did', () => {
		const text = renderPeersScreen({
			summary: summary(),
			roster: fixture({ status: 'offline', seenAt: NOW - 5 * 60_000 }),
			heldLocal: [],
			now: NOW,
			columns: 100,
		})
		expect(text).toContain('[offline]  ·  desk-linux  ·  last seen 5m ago')
		expect(text).toContain('swift-finch')
		expect(text).toContain('offline')
	})

	it.each([100, 60, 40])(
		'fits %i columns: nothing overflows, and each fact is still there',
		(columns) => {
			const text = renderPeersScreen({
				summary: summary({ joinRequests: [join], held: [remoteHeld] }),
				roster: fixture(),
				selfRef: 'aaaaaa',
				heldLocal: [
					{
						id: 'l1',
						fromName: 'sibling',
						fromRef: 'ffffff',
						reason: 'its permission mode differs (it is in bypass, you are in auto)',
						text: 'Pick up the release checklist.',
						expiresAt: NOW + 9 * 60_000,
					},
				],
				now: NOW,
				columns,
			})
			for (const line of text.split('\n'))
				expect(Array.from(line).length, `${columns}: ${line}`).toBeLessThanOrEqual(columns)
			for (const fact of [
				'calm-heron',
				'quiet-otter',
				'swift-finch',
				'desk-mini',
				'482',
				'913',
				'sibling',
			])
				expect(text.replace(/\s+/g, ' '), fact).toContain(fact)
			// A narrow screen keeps the name and state on the row and the rest on lines under it.
			if (columns >= 60) expect(text).toContain('[idle]  ·  swift-finch  ·  desk-linux')
			else expect(text).toContain('      desk-linux')
		},
	)

	it.each([80, 110])(
		'reads as a list at %i columns, nothing run together or past the edge',
		(columns) => {
			const long = fixture()
			const view: RosterView = {
				machines: [
					long.machines[0] as RosterMachineView,
					{
						...(long.machines[1] as RosterMachineView),
						role: 'the machine that builds and signs every release candidate before it goes out',
						sessions: [
							session('cccccc', 'swift-finch', 'api-server', 'prompt', {
								role: 'you own the long migration of the billing tables and report each step to the person',
							}),
							session('dddddd', 'brisk-marten', 'api-server', 'bypass', { state: 'running' }),
						],
					},
				],
			}
			const lines = renderPeersScreen({
				summary: summary(),
				roster: view,
				selfRef: 'aaaaaa',
				heldLocal: [],
				now: NOW,
				columns,
			}).split('\n')
			for (const line of lines) expect(Array.from(line).length, line).toBeLessThanOrEqual(columns)
			expect(lines).toContain('Namzu sessions (4):')
			expect(
				lines.filter((l) => /^ {2}\[(idle|running)\]/.test(l) && l.endsWith('  ·  desk-linux')),
			).toHaveLength(2)
			expect(lines).toContain('  [running]  ·  brisk-marten  ·  desk-linux')
			expect(lines).toContain('  [idle]  ·  calm-heron  ·  this terminal')
			expect(lines).toContain('      in api-server · bypass mode')
			const cut = lines.find((l) => l.includes('role: you own')) as string
			expect(cut).toMatch(/^ {6}role: you own the long /)
			if (columns === 80) expect(cut).toMatch(/…$/)
			const head = lines.find((l) => l.startsWith('  [online]  ·  desk-linux')) as string
			expect(head).toMatch(/· {2}role: the machine that builds/)
		},
	)

	it('prints a whole role when no width is given, as piped output does', () => {
		const view = fixture()
		const role = 'x'.repeat(120)
		const text = renderRosterList(
			{
				machines: [
					{
						...(view.machines[0] as RosterMachineView),
						sessions: [session('aaaaaa', 'calm-heron', 'namzu', 'classify', { role })],
					},
				],
			},
			{ now: NOW },
		)
		expect(text).toContain(`role: ${role}`)
	})

	it('offers one row per decision: allow and deny for each held message and each request', () => {
		const actions = peersActions(summary({ joinRequests: [join], held: [remoteHeld] }), [])
		expect(actions.map((a) => a.kind)).toEqual([
			'allow-join',
			'deny-join',
			'allow-held-remote',
			'deny-held-remote',
		])
	})

	it('offers the picker rows that cancel a waiting request and choose between nearby networks', () => {
		const joining = { code: '482 913', endpoint: '192.168.1.5:47310' }
		const nearby = [
			{ netId: 'aaaaaaaaaaaaaaaa', host: '192.168.1.5', port: 47310 },
			{ netId: 'bbbbbbbbbbbbbbbb', host: '192.168.1.9', port: 47310 },
		]
		expect(peersActions(summary({ joining }), []).map((a) => a.kind)).toEqual(['cancel-join'])
		expect(
			peersActions(summary({ state: 'ambiguous', nearby, nearbyNetworks: 2 }), []).map(
				(a) => a.kind,
			),
		).toEqual(['join-nearby', 'join-nearby'])
		const text = renderPeersScreen({
			summary: summary({ state: 'ambiguous', nearby, nearbyNetworks: 2 }),
			roster: undefined,
			selfRef: 'aaaaaa',
			heldLocal: [],
			now: NOW,
			columns: 80,
		})
		expect(text).toContain('More than one Namzu network is nearby (2)')
		expect(text).toContain('192.168.1.9:47310')
	})

	it('every row fits a picker at 110 and 80 columns, the held reason being on the Held line instead', () => {
		const actions = peersActions(
			summary({
				joinRequests: [join],
				held: [remoteHeld],
				joining: { code: '482 913', endpoint: 'x' },
			}),
			[
				{
					id: 'l1',
					fromName: 'swift-finch',
					fromRef: 'bbbbbb',
					reason: remoteHeld.reason,
					text: 'hi',
					expiresAt: NOW + 60_000,
				},
			],
		)
		for (const action of actions) {
			const { label, description } = describeAction(action)
			// The picker draws "  <cursor> <label>   <description>" in one row from 80 columns up; wide rows wrap.
			expect(Array.from(label).length + Array.from(description).length, label).toBeLessThanOrEqual(
				80 - 12,
			)
			expect(description).not.toContain('permission mode')
		}
		const held = renderPeersScreen({
			summary: summary({ held: [remoteHeld] }),
			roster: undefined,
			selfRef: 'aaaaaa',
			heldLocal: [],
			now: NOW,
			columns: 110,
		})
		expect(held).toContain('its permission mode differs')
	})
})

describe('namzu peers status', () => {
	it('says how many machines are in the network and what waits', () => {
		const text = renderStatus(
			summary({
				machine: { id: 'a'.repeat(64), name: 'studio-air' },
				joinRequests: [join],
				held: [remoteHeld],
			}),
			NOW,
		)
		expect(text).toContain('Your Namzu network: on')
		expect(text).toContain('This machine: studio-air')
		expect(text).toContain('Machines: 2')
		expect(text).toContain(
			'desk-mini wants to join: code 482 913, from 192.168.1.23, expires in 8 min',
		)
		expect(text).toContain('namzu peers allow 482913')
		expect(text).toContain('Held messages: 1')
	})

	it('tells a removed machine what happened and the one that is waiting for an Allow', () => {
		expect(renderStatus(summary({ removed: true }), NOW)).toContain(
			'was removed from your Namzu network',
		)
		expect(
			renderStatus(
				summary({
					state: 'searching',
					members: 0,
					joining: { code: '123 456', endpoint: '10.0.0.2:47310' },
				}),
				NOW,
			),
		).toContain('Waiting for an Allow on 10.0.0.2:47310; code 123 456.')
	})
})

describe('fit', () => {
	it('wraps a long line under its own indent and leaves short ones alone', () => {
		expect(fit(['  short', '  one two three four five six'], 20)).toEqual([
			'  short',
			'  one two three four',
			'    five six',
		])
	})
})

describe('trusted networks on the screens', () => {
	it('lists this terminal first, at 80 columns, narrow and unwidth', () => {
		for (const columns of [80, 40, undefined]) {
			const lines = renderRosterList(fixture(), { selfRef: 'bbbbbb', now: NOW, columns }).split(
				'\n',
			)
			expect(lines[1], `columns ${columns}`).toContain('quiet-otter')
			expect(lines.join('\n')).toContain('this terminal')
		}
	})

	it('offers Allow and trust only for a recognised network that is not trusted yet', () => {
		const withOffer = { ...join, trustOffer: { suggestedName: 'Network 1' } }
		const actions = peersActions(summary({ joinRequests: [withOffer] }), [])
		expect(actions.map((a) => a.kind)).toEqual(['allow-join', 'allow-join-trust', 'deny-join'])
		expect(describeAction(actions[1] as never).label).toBe(
			'Allow and trust this network (Network 1)',
		)
		expect(peersActions(summary({ joinRequests: [join] }), []).map((a) => a.kind)).toEqual([
			'allow-join',
			'deny-join',
		])
		const text = renderPeersScreen({
			summary: summary({ joinRequests: [withOffer] }),
			roster: undefined,
			heldLocal: [],
			now: NOW,
			columns: 100,
		})
		expect(text).toContain('This network is not trusted yet')
	})

	it('lists trusted networks with a way to stop, and says so in the status', () => {
		const trusted = { id: 'a1b2c3d4', name: 'Home', trustedAt: NOW }
		const s = summary({ trustedNetworks: [trusted] })
		const screen = renderPeersScreen({
			summary: s,
			roster: undefined,
			heldLocal: [],
			now: NOW,
			columns: 100,
		})
		expect(screen).toContain('Trusted networks (1)')
		expect(screen).toContain('Home: new machines on it join without asking')
		const actions = peersActions(s, [])
		expect(actions.map((a) => a.kind)).toEqual(['untrust-network'])
		expect(describeAction(actions[0] as never).label).toBe('Stop trusting Home')
		expect(renderStatus(s, NOW)).toContain('Trusted networks: Home')
	})
})

describe('the session list', () => {
	const row = (over: Partial<SessionRow>): SessionRow => ({
		ref: 'aaaaaa',
		name: 'calm-heron',
		named: true,
		state: 'idle',
		...over,
	})

	it('says what is absent when there is nothing to list', () => {
		expect(formatSessionList([], { now: NOW })).toBe('No Namzu sessions are running.')
		expect(formatSessionList([], { now: NOW, emptyText: 'None here.' })).toBe('None here.')
	})

	it('puts the bracketed state first and shows each state', () => {
		const text = formatSessionList(
			[
				row({ ref: '000001', name: 'a', state: 'idle' }),
				row({ ref: '000002', name: 'b', state: 'running' }),
				row({ ref: '000003', name: 'c', state: 'awaiting-approval' }),
				row({ ref: '000004', name: 'd', state: 'offline', machine: 'desk' }),
			],
			{ now: NOW },
		)
		for (const state of ['idle', 'running', 'awaiting-approval', 'offline'])
			expect(text).toMatch(new RegExp(`^ {2}\\[${state}\\] {2}· {2}`, 'm'))
	})

	it('writes the age as the single largest unit and never a negative one', () => {
		expect([0, 23_000, 7 * 60_000, 7 * 3_600_000, 3 * 86_400_000, -5000].map(ageWord)).toEqual([
			'0s',
			'23s',
			'7m',
			'7h',
			'3d',
			'0s',
		])
		expect(formatSessionList([row({ startedAt: NOW + 60_000 })], { now: NOW })).toContain(
			'started 0s ago',
		)
	})

	it('sorts this terminal first, then this machine by start time (unknown last), then machines by name', () => {
		const text = formatSessionList(
			[
				row({ ref: '000001', name: 'zeta', machine: 'b-box' }),
				row({ ref: '000002', name: 'late', startedAt: NOW - 1_000 }),
				row({ ref: '000003', name: 'alpha', machine: 'a-box' }),
				row({ ref: '000004', name: 'unknown-start' }),
				row({ ref: '000005', name: 'early', startedAt: NOW - 90_000 }),
				row({ ref: '000006', name: 'me', self: true, startedAt: NOW - 5_000 }),
			],
			{ now: NOW },
		)
		const order = text
			.split('\n')
			.filter((l) => l.startsWith('  ['))
			.map((l) => l.split('  ·  ')[1])
		expect(order).toEqual(['me', 'early', 'late', 'unknown-start', 'alpha', 'zeta'])
	})

	it('reads an unnamed session as a placeholder, with its folder on the second line', () => {
		const text = formatSessionList(
			[row({ name: 'proj', named: false, folder: 'proj', startedAt: NOW - 23_000 })],
			{ now: NOW },
		)
		expect(text).toContain('  [idle]  ·  (unnamed session)  ·  started 23s ago\n      in proj')
		expect(text).toContain('/rename <name>')
		expect(formatSessionList([row({})], { now: NOW })).not.toContain('/rename')
	})

	it('adds the ref only where two rows read the same', () => {
		const text = formatSessionList(
			[
				row({ ref: '000001', name: 'a', named: false }),
				row({ ref: '000002', name: 'b', named: false }),
				row({ ref: '000003', name: 'solo' }),
			],
			{ now: NOW },
		)
		expect(text).toContain('(unnamed session) [000001]')
		expect(text).toContain('(unnamed session) [000002]')
		expect(text).not.toContain('solo [')
	})

	it('names the machine of a session on another machine in the last field', () => {
		const text = formatSessionList([row({ machine: 'desk-linux', startedAt: NOW - 9_000 })], {
			now: NOW,
		})
		expect(text).toContain('  [idle]  ·  calm-heron  ·  desk-linux')
		expect(text).not.toContain('started')
	})

	it('keeps every line inside a narrow screen and the name and state on the first line', () => {
		const rows = [
			row({
				self: true,
				startedAt: NOW - 3_600_000,
				folder: 'a-long-project-folder-name',
				mode: 'auto',
				role: 'you own the long migration of the billing tables and report each step',
			}),
			row({ ref: '000002', name: 'swift-finch', machine: 'desk-linux' }),
		]
		for (const columns of [40, 36]) {
			const lines = formatSessionList(rows, { now: NOW, columns }).split('\n')
			for (const line of lines) expect(Array.from(line).length, line).toBeLessThanOrEqual(columns)
			expect(lines).toContain('  [idle]  ·  calm-heron')
		}
	})

	it('adds a short machines section only when there is more than one machine or a role', () => {
		const one: MachineRow = { name: 'solo', self: true, online: true }
		expect(formatSessionList([row({})], { now: NOW, machines: [one] })).not.toContain('Machines')
		expect(
			formatSessionList([row({})], { now: NOW, machines: [{ ...one, role: 'orchestrator' }] }),
		).toContain('  [online]  ·  solo  ·  this machine  ·  role: orchestrator')
	})

	it('builds rows from what list_sessions reports, treating the folder name as no name', () => {
		const rows = rowsFromLocalList([
			{ ref: 'aaaaaa', title: 'proj', cwd: '/work/proj', state: 'idle', started_at: 5, self: true },
			{
				ref: 'bbbbbb',
				title: 'review-lane',
				cwd: '/work/proj',
				state: 'running',
				permission_mode: 'auto',
			},
		])
		expect(rows[0]).toMatchObject({ named: false, folder: 'proj', startedAt: 5, self: true })
		expect(rows[1]).toMatchObject({ named: true, mode: 'auto', state: 'running' })
	})
})
