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
	it('lists each machine as a heading and its sessions indented under it, the role last', () => {
		expect(renderRosterList(fixture())).toBe(
			[
				'studio-air · this machine · online',
				'  calm-heron · namzu · idle · auto · role: orchestrator',
				'  quiet-otter · namzu · running · auto · role: you will build the parser',
				'desk-linux · online',
				'  swift-finch · api-server · idle · prompt',
				'  brisk-marten · api-server · idle · auto',
			].join('\n'),
		)
	})

	it('shows the sessions of a machine that did not answer as offline', () => {
		const text = renderRosterList(fixture({ status: 'offline', seenAt: undefined }))
		expect(text).toContain('swift-finch · api-server · offline')
		expect(
			renderRosterList({
				machines: [
					{
						...fixture().machines[1],
						sessions: [],
						status: 'offline',
						seenAt: undefined,
					} as RosterMachineView,
				],
			}),
		).toBe('desk-linux · offline')
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
		expect(text.indexOf('Join requests (1)')).toBeLessThan(text.indexOf('studio-air'))
		expect(text).toContain('studio-air · this machine · online')
		expect(text).toContain('calm-heron (this terminal)')
		expect(text).toContain('desk-linux · online')
		expect(text.indexOf('Held (1)')).toBeGreaterThan(text.indexOf('desk-linux'))
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
		expect(text).toContain('desk-linux · last seen 5 min ago')
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
			if (columns >= 60) expect(text).toContain('swift-finch · api-server · idle · prompt')
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
			const row = lines.filter((l) => l.startsWith('  ') && l.includes(' · '))
			// every session is one line indented under a machine heading, fields apart by " · "
			expect(row).toHaveLength(4)
			expect(lines).toContain('  brisk-marten · api-server · running · bypass')
			expect(lines).toContain(
				'  calm-heron (this terminal) · namzu · idle · auto · role: orchestrator',
			)
			const cut = lines.find((l) => l.includes('swift-finch')) as string
			expect(cut).toMatch(/ · role: you own the long .*…$/)
			const head = lines.find((l) => l.startsWith('desk-linux')) as string
			expect(head).toMatch(/^desk-linux · online · role: the machine that builds/)
			expect(lines.filter((l) => /^\S/.test(l) && l.includes(' · ')).length).toBeGreaterThanOrEqual(
				3,
			)
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
	it('lists this terminal first under its machine, at 80 columns and unwidth', () => {
		for (const columns of [80, 40, undefined]) {
			const text = renderRosterList(fixture(), { selfRef: 'bbbbbb', now: NOW, columns })
			const own = text.split('\n').findIndex((l) => l.includes('quiet-otter'))
			const other = text.split('\n').findIndex((l) => l.includes('calm-heron'))
			expect(own, `columns ${columns}`).toBeGreaterThan(0)
			expect(own).toBeLessThan(other)
			expect(text.split('\n')[own - 1]).toContain('studio-air')
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

describe('the same computer on the lists', () => {
	it("puts this computer's other homes right after this machine, marked, and says so in JSON", () => {
		const base = fixture()
		const view: RosterView = {
			machines: [
				base.machines[0] as RosterView['machines'][number],
				base.machines[1] as RosterView['machines'][number],
				{
					machineId: 'c'.repeat(64),
					name: 'studio-air (autodev)',
					status: 'online',
					seenAt: NOW,
					sameComputer: true,
					sessions: [],
				},
			],
		}
		const heads = renderRosterList(view, { now: NOW })
			.split('\n')
			.filter((l) => !l.startsWith(' '))
		expect(heads).toEqual([
			'studio-air · this machine · online',
			'studio-air (autodev) · this computer · online',
			'desk-linux · online',
		])
		expect(rosterJson(view).find((m) => m.name === 'studio-air (autodev)')?.sameComputer).toBe(true)
		expect(rosterJson(view).find((m) => m.name === 'desk-linux')?.sameComputer).toBeUndefined()
	})
})
