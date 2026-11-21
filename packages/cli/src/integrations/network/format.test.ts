import type { RosterMachineView, RosterSession, RosterView } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
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
	joinRequests: [],
	held: [],
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
	it('lists every machine and session in plain columns, with the role last', () => {
		expect(renderRosterList(fixture())).toBe(
			[
				'studio-air (this machine)',
				'  calm-heron    namzu       idle     auto    orchestrator',
				'  quiet-otter   namzu       running  auto    you will build the parser',
				'desk-linux',
				'  swift-finch   api-server  idle     prompt',
				'  brisk-marten  api-server  idle     auto',
			].join('\n'),
		)
	})

	it('shows the sessions of a machine that did not answer as offline', () => {
		const text = renderRosterList(fixture({ status: 'offline' }))
		expect(text).toMatch(/swift-finch\s+api-server\s+offline/)
		expect(
			renderRosterList({
				machines: [
					{ ...fixture().machines[1], sessions: [], status: 'offline' } as RosterMachineView,
				],
			}),
		).toBe('desk-linux (offline)')
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

	it('draws the machines, what is held and who asks to join, in that order', () => {
		const text = full()
		expect(text.indexOf('Your Namzu network · on · 2 machines')).toBe(0)
		expect(text).toContain('This machine: studio-air')
		expect(text).toContain('calm-heron (this terminal)')
		expect(text).toContain('desk-linux  (idle · seen just now)')
		expect(text.indexOf('Held (1)')).toBeGreaterThan(text.indexOf('desk-linux'))
		expect(text.indexOf('Join requests (1)')).toBeGreaterThan(text.indexOf('Held (1)'))
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
		expect(text).toContain('desk-linux  (offline · seen 5 min ago)')
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
			// A narrow screen drops the columns and puts the role on its own line under the row.
			if (columns < 60) expect(text).not.toMatch(/api-server/)
			if (columns >= 60) expect(text).toContain('in api-server')
		},
	)

	it('offers one row per decision: allow and deny for each held message and each request', () => {
		const actions = peersActions(summary({ joinRequests: [join], held: [remoteHeld] }), [])
		expect(actions.map((a) => a.kind)).toEqual([
			'allow-held-remote',
			'deny-held-remote',
			'allow-join',
			'deny-join',
		])
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
