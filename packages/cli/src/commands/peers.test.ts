import { mkdirSync, mkdtempSync } from 'node:fs'
import { type NetworkInterfaceInfo, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { EXIT_FAIL, EXIT_HELD, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { ControlError } from '../integrations/network/control.js'
import type { NetworkControl, NetworkSummary } from '../integrations/network/types.js'
import { openLivePeers } from '../integrations/peers/runtime.js'
import { sendToTerminal } from '../integrations/peers/send-once.js'
import { planLaunchMode } from '../permissions/launch.js'
import type { PermissionSettings } from '../permissions/settings.js'
import {
	type PeersDeps,
	type PeersIo,
	executePeers,
	parsePeersArgs,
	peerSenderMode,
	readAuditTail,
	receiptExitCode,
	renderAuditLine,
	renderListing,
	renderReceipt,
} from './peers.js'

it('parses list and send with flags anywhere', () => {
	expect(parsePeersArgs(['list', '--json'])).toEqual({ verb: 'list', json: true })
	expect(parsePeersArgs(['send', 'ab12cd', 'say', 'hi', '--mode', 'auto', '--json'])).toEqual({
		verb: 'send',
		json: true,
		target: 'ab12cd',
		words: ['say', 'hi'],
		mode: 'auto',
	})
	expect(parsePeersArgs(['send', 'ab12cd', '--file', '-'])).toEqual({
		verb: 'send',
		json: false,
		target: 'ab12cd',
		words: [],
		file: '-',
	})
	expect(parsePeersArgs(['send', 't', '--', '--json', 'x'])).toMatchObject({
		words: ['--json', 'x'],
		json: false,
	})
})

it('rejects bad usage', () => {
	for (const args of [
		['nope'],
		['list', 'x'],
		['send'],
		['send', 'a'],
		['send', 'a', '--file', 'f', 'words'],
		['send', 'a', 'm', '--mode'],
		['send', 'a', 'm', '--bogus'],
	]) {
		expect(parsePeersArgs(args)).toHaveProperty('error')
	}
})

it('renders receipts in plain words with distinct exit codes', () => {
	const queued = { status: 'queued', reason: 'x' } as const
	const refused = {
		status: 'refused',
		reason: 'The terminals have different permission modes.',
	} as const
	const gone = { status: 'unreachable', reason: 'No receipt arrived.' } as const
	const held = { status: 'held', reason: 'Held for the person at the receiving terminal.' } as const
	expect(renderReceipt(held)).toBe('Held: Held for the person at the receiving terminal.')
	expect(receiptExitCode(held)).toBe(4)
	expect(renderReceipt(queued)).toBe(
		'Queued: accepted into the live inbox, not proof the model read it.',
	)
	expect(renderReceipt(refused)).toBe('Refused: The terminals have different permission modes.')
	expect(renderReceipt(gone)).toBe('Unreachable: No receipt arrived.')
	expect([queued, refused, gone].map(receiptExitCode)).toEqual([0, 1, 69])
})

it('renders the listing', () => {
	expect(renderListing([])).toBe('No Namzu sessions are running in this project.')
	expect(
		renderListing(
			[
				{
					ref: 'ab12cd',
					sessionId: 's',
					title: 'proj',
					state: 'idle',
					mode: 'classify',
					acceptsMessages: true,
					folder: 'proj',
					named: false,
					startedAt: 1_000,
				},
			],
			{ now: 424_000 },
		),
	).toBe(
		[
			'Namzu sessions in this project (1):',
			'  [idle]  ·  (unnamed session)  ·  started 7m ago',
			'      in proj  ·  auto mode',
			'',
			'Sessions shown as (unnamed session) have no name of their own: /rename <name> in that terminal gives one others can message.',
		].join('\n'),
	)
})

it('acts, with no --mode, in the mode a new terminal here starts in', () => {
	const settings: (PermissionSettings | undefined)[] = [
		undefined,
		{ defaultMode: 'plan' },
		{ disableAutoMode: true },
	]
	for (const each of settings) {
		expect(peerSenderMode(undefined, each)).toEqual(
			planLaunchMode({ settings: each, interactive: true }),
		)
	}
	expect(peerSenderMode(undefined, undefined)).toMatchObject({ plan: { mode: 'classify' } })
	expect(peerSenderMode(undefined, { disableAutoMode: true })).toMatchObject({
		plan: { mode: 'prompt' },
	})
	expect(peerSenderMode('prompt', undefined)).toMatchObject({ plan: { mode: 'prompt' } })
})

it('reaches a terminal in its default mode from a send that names none', async () => {
	const root = mkdtempSync(join(tmpdir(), 'peers-default-'))
	const cwd = join(root, 'p')
	mkdirSync(cwd)
	const common = { home: join(root, 'h'), cwd, version: 'fixture', env: {} }
	const terminal = planLaunchMode({ interactive: true })
	const sender = peerSenderMode(undefined, undefined)
	if ('error' in terminal || 'error' in sender) throw new Error('no plan')
	const receiver = await openLivePeers({
		...common,
		mode: () => terminal.plan.mode,
		owner: () => 0,
		state: () => 'idle' as const,
		ready: () => true,
		available: () => {},
		report: () => {},
	})
	try {
		const receipt = await sendToTerminal({
			...common,
			target: receiver.ref,
			message: 'hi',
			mode: sender.plan.mode,
		})
		expect(receipt.status).toBe('queued')
	} finally {
		await receiver.close()
		removeTempDir(root)
	}
})

it('reads a bare `namzu peers` as list, and every verb of the network', () => {
	expect(parsePeersArgs([])).toEqual({ verb: 'list', json: false })
	expect(parsePeersArgs(['status', '--json'])).toEqual({ verb: 'status', json: true })
	expect(parsePeersArgs(['on'])).toEqual({ verb: 'on', json: false, anyway: false })
	expect(parsePeersArgs(['on', '--anyway'])).toEqual({ verb: 'on', json: false, anyway: true })
	expect(parsePeersArgs(['off'])).toEqual({ verb: 'off', json: false })
	expect(parsePeersArgs(['allow', '482', '913'])).toEqual({
		verb: 'allow',
		json: false,
		query: '482913',
	})
	expect(parsePeersArgs(['deny', 'desk', 'mini'])).toEqual({
		verb: 'deny',
		json: false,
		query: 'desk mini',
	})
	expect(parsePeersArgs(['remove', 'desk-linux', '--and-its-admissions'])).toEqual({
		verb: 'remove',
		json: false,
		machine: 'desk-linux',
		cascade: true,
	})
	expect(parsePeersArgs(['rename', 'studio', 'air'])).toEqual({
		verb: 'rename',
		json: false,
		name: 'studio air',
	})
	expect(parsePeersArgs(['role', 'calm-heron', 'you', 'will', 'build', 'the', 'parser'])).toEqual({
		verb: 'role',
		json: false,
		target: 'calm-heron',
		role: 'you will build the parser',
	})
	expect(parsePeersArgs(['role', 'calm-heron', '--clear'])).toEqual({
		verb: 'role',
		json: false,
		target: 'calm-heron',
		role: null,
	})
	expect(parsePeersArgs(['role', 'desk-linux/', 'build', 'box'])).toMatchObject({
		target: 'desk-linux/',
	})
	expect(parsePeersArgs(['add', '192.168.1.7:47310'])).toEqual({
		verb: 'add',
		json: false,
		hostPort: '192.168.1.7:47310',
	})
	expect(parsePeersArgs(['join'])).toEqual({ verb: 'join', json: false })
	expect(parsePeersArgs(['join', '10.0.0.2'])).toEqual({
		verb: 'join',
		json: false,
		hostPort: '10.0.0.2',
	})
	expect(parsePeersArgs(['log', '-n', '5'])).toEqual({ verb: 'log', json: false, count: 5 })
	expect(parsePeersArgs(['log'])).toEqual({ verb: 'log', json: false, count: 50 })
	expect(parsePeersArgs(['send', 'desk-linux/swift-finch', 'hi'])).toMatchObject({
		verb: 'send',
		target: 'desk-linux/swift-finch',
	})
})

it('rejects bad usage of the network verbs', () => {
	for (const args of [
		['allow'],
		['deny'],
		['remove'],
		['rename'],
		['role'],
		['role', 'x'],
		['role', 'x', '--clear', 'words'],
		['add'],
		['add', 'a', 'b'],
		['add', 'not a host!'],
		['add', 'host:99999'],
		['join', 'a', 'b'],
		['log', '-n'],
		['log', '-n', '0'],
		['log', 'extra'],
		['on', 'now'],
		['status', 'x'],
		['list', '--anyway'],
	])
		expect(parsePeersArgs(args), args.join(' ')).toHaveProperty('error')
})

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
	machine: { id: 'a'.repeat(64), name: 'studio-air' },
	...extra,
})

function harness(overrides: Partial<NetworkControl> = {}, leader = true) {
	const root = mkdtempSync(join(tmpdir(), 'peers-cmd-'))
	const calls: unknown[][] = []
	const written: string[][] = []
	const out: { value: object; text: string }[] = []
	const errors: { message: string; code: number }[] = []
	const track =
		<T>(_name: string, result: T) =>
		async (..._args: unknown[]): Promise<T> =>
			result
	const base: NetworkControl = {
		summary: track('summary', summary()),
		roster: track('roster', {
			machines: [
				{
					machineId: 'a'.repeat(64),
					name: 'studio-air',
					status: 'self' as const,
					sessions: [
						{
							ref: 'aaaaaa',
							name: 'calm-heron',
							folder: 'namzu',
							state: 'idle' as const,
							mode: 'classify',
							acceptsMessages: true,
							kind: 'tui' as const,
						},
					],
				},
			],
		}),
		allow: track('allow', {
			requestId: 'r',
			name: 'desk-mini',
			code: '482 913',
			sourceAddr: '10.0.0.4',
			expiresAt: 1,
		}),
		deny: track('deny', {
			requestId: 'r',
			name: 'desk-mini',
			code: '482 913',
			sourceAddr: '10.0.0.4',
			expiresAt: 1,
		}),
		networks: track('networks', [] as { id: string; name: string; trustedAt: number }[]),
		untrust: track('untrust', { id: 'a1b2c3d4', name: 'Home', trustedAt: 1 }),
		renameNetwork: track('renameNetwork', { id: 'a1b2c3d4', name: 'Office', trustedAt: 1 }),
		remove: track('remove', { removed: ['desk-linux'], admitted: [] as string[] }),
		rename: track('rename', undefined),
		setRole: track('setRole', { status: 'applied' as const }),
		send: track('send', undefined),
		add: track('add', 'added' as const),
		join: track('join', { networks: [] as string[] }),
		cancelJoin: track('cancelJoin', false),
		allowHeld: track('allowHeld', undefined),
		denyHeld: track('denyHeld', undefined),
		reportDelivered: track('reportDelivered', undefined),
		...overrides,
	}
	// Every call is recorded, whoever answers it.
	const control = Object.fromEntries(
		Object.entries(base).map(([name, fn]) => [
			name,
			(...args: unknown[]) => {
				calls.push([name, ...args])
				return (fn as (...a: unknown[]) => unknown)(...args)
			},
		]),
	) as unknown as NetworkControl
	const io: PeersIo = {
		json: false,
		print: (value, text) => out.push({ value, text }),
		fail: (message, code) => {
			errors.push({ message, code })
			return code
		},
	}
	const deps: PeersDeps = {
		home: join(root, 'h'),
		cwd: root,
		version: 'fixture',
		control,
		leaderUp: () => leader,
		config: undefined,
		env: {},
		writeSetting: (key, text) => {
			written.push([key, text])
			return { ok: true, message: `Set ${key}.` }
		},
		permissionSettings: undefined,
		now: () => 1_700_000_000_000,
		interfaces: () => ({
			eth0: [
				{
					address: '192.168.1.20',
					netmask: '255.255.255.0',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: null,
				} as NetworkInterfaceInfo,
			],
		}),
	}
	return { deps, io, calls, written, out, errors, root, done: () => removeTempDir(root) }
}

const run = (h: ReturnType<typeof harness>, args: string[]) => {
	const parsed = parsePeersArgs(args)
	if ('error' in parsed) throw new Error(parsed.error)
	return executePeers(parsed, h.deps, h.io)
}

it('lists every machine when the network runs, and only this folder when it does not', async () => {
	const on = harness()
	expect(await run(on, ['list'])).toBe(EXIT_OK)
	expect(on.out[0]?.text).toContain('Namzu sessions (1):')
	expect(on.out[0]?.text).toContain('[idle]  ·  calm-heron')
	expect(on.out[0]?.value).toHaveProperty('machines')
	on.done()
	const off = harness({}, false)
	expect(await run(off, ['list'])).toBe(EXIT_OK)
	expect(off.out[0]?.text).toBe('No Namzu sessions are running in this project.')
	expect(off.out[0]?.value).not.toHaveProperty('machines')
	off.done()
})

it('tells a machine that was removed why its list has no machines', async () => {
	const removed = harness({
		roster: async () => ({ machines: [] }),
		summary: async () => summary({ state: 'removed', removed: true, members: 0 }),
	})
	expect(await run(removed, ['list'])).toBe(EXIT_OK)
	expect(removed.out[0]?.text).toContain('No Namzu sessions are running in this project.')
	expect(removed.out[0]?.text).toContain('This machine was removed from your Namzu network')
	expect(removed.out[0]?.value).toMatchObject({ network: { state: 'removed', removed: true } })
	removed.done()
})

it('withdraws a waiting request with cancel, and says so when none waits', async () => {
	const waiting = harness({ cancelJoin: async () => true })
	expect(await run(waiting, ['cancel'])).toBe(EXIT_OK)
	expect(waiting.out[0]?.text).toBe('Withdrew the request to join.')
	const none = harness({ cancelJoin: async () => false })
	await run(none, ['cancel'])
	expect(none.out[0]?.text).toBe('No request to join is waiting.')
	expect(parsePeersArgs(['cancel', 'x'])).toHaveProperty('error')
	waiting.done()
	none.done()
})

it('says the network is off when no terminal runs it, and why when the switch is off', async () => {
	const none = harness({}, false)
	await run(none, ['status'])
	expect(none.out[0]?.text).toBe('No Namzu terminal is running here; the network needs one open.')
	none.done()
	const off = harness({}, false)
	const parsed = parsePeersArgs(['status'])
	if ('error' in parsed) throw new Error('parse')
	await executePeers(parsed, { ...off.deps, config: { enabled: false } }, off.io)
	expect(off.out[0]?.text).toContain('namzu peers on')
	off.done()
	const up = harness()
	expect(await run(up, ['status'])).toBe(EXIT_OK)
	expect(up.out[0]?.text).toContain('Your Namzu network: on')
	up.done()
})

it('turns the network on and off by writing the setting, and says when it applies', async () => {
	const h = harness()
	expect(await run(h, ['off'])).toBe(EXIT_OK)
	expect(await run(h, ['on'])).toBe(EXIT_OK)
	expect(await run(h, ['on', '--anyway'])).toBe(EXIT_OK)
	expect(h.written).toEqual([
		['network.enabled', 'false'],
		['network.enabled', 'auto'],
		['network.enabled', 'true'],
	])
	expect(h.out[0]?.text).toContain('already open pick this up when they next start')
	h.done()
})

it('allows, denies and removes through the terminal that runs the network', async () => {
	const h = harness({
		remove: async () => ({ removed: ['desk-linux', 'desk-mini'], admitted: ['desk-mini'] }),
	})
	expect(await run(h, ['allow', '482', '913'])).toBe(EXIT_OK)
	expect(h.out[0]?.text).toBe('Allowed desk-mini to join your Namzu network.')
	expect(await run(h, ['deny', 'desk-mini'])).toBe(EXIT_OK)
	expect(h.out[1]?.text).toBe('Denied desk-mini.')
	expect(await run(h, ['remove', 'desk-linux'])).toBe(EXIT_OK)
	expect(h.out[2]?.text).toContain('it had let in desk-mini'.replace('it', 'It'))
	expect(h.out[2]?.text).toContain('--and-its-admissions')
	expect(await run(h, ['remove', 'desk-linux', '--and-its-admissions'])).toBe(EXIT_OK)
	expect(h.out[3]?.text).toContain('Also removed: desk-mini')
	expect(h.calls.filter(([name]) => name === 'allow')).toEqual([['allow', '482913']])
	h.done()
})

it('sets and clears a role, telling the person it grants nothing', async () => {
	const h = harness()
	expect(await run(h, ['role', 'calm-heron', 'orchestrator'])).toBe(EXIT_OK)
	expect(h.out[0]?.text).toContain('grants nothing')
	expect(await run(h, ['role', 'calm-heron', '--clear'])).toBe(EXIT_OK)
	expect(h.out[1]?.text).toBe('Cleared the role of calm-heron.')
	expect(h.calls.filter(([name]) => name === 'setRole')).toEqual([
		['setRole', 'calm-heron', 'orchestrator'],
		['setRole', 'calm-heron', null],
	])
	h.done()
	const refused = harness({
		setRole: async () => ({ status: 'refused', reason: 'That session is not running here.' }),
	})
	expect(await run(refused, ['role', 'ghost', 'x'])).toBe(EXIT_FAIL)
	expect(refused.errors[0]?.message).toBe('That session is not running here.')
	refused.done()
})

it('renames this machine in the setting, and live when a terminal runs the network', async () => {
	const h = harness()
	expect(await run(h, ['rename', 'studio', 'air'])).toBe(EXIT_OK)
	expect(h.written).toEqual([['network.machineName', 'studio air']])
	expect(h.calls.filter(([name]) => name === 'rename')).toEqual([['rename', 'studio air']])
	expect(h.out[0]?.text).toBe('This machine is now called studio air.')
	h.done()
	const idle = harness({}, false)
	expect(await run(idle, ['rename', 'studio'])).toBe(EXIT_OK)
	expect(idle.out[0]?.text).toContain('next time a Namzu terminal starts the network')
	idle.done()
})

it('adds a machine by address, and asks to join with it when this machine has no network yet', async () => {
	const h = harness({ add: async () => 'join-requested' })
	expect(await run(h, ['add', '192.168.1.7:47310'])).toBe(EXIT_OK)
	expect(h.out[0]?.text).toContain('Allow it on one of your other machines')
	const added = harness()
	expect(await run(added, ['add', '192.168.1.7'])).toBe(EXIT_OK)
	expect(added.out[0]?.text).toBe('Added 192.168.1.7.')
	h.done()
	added.done()
})

it('lists the networks nearby, or says there are none and what to do', async () => {
	const none = harness()
	await run(none, ['join'])
	expect(none.out[0]?.text).toContain('namzu peers add <host[:port]>')
	const two = harness({
		join: async () => ({ networks: ['192.168.1.5:47310', '192.168.1.9:47310'] }),
	})
	await run(two, ['join'])
	expect(two.out[0]?.text).toContain('Found 2 Namzu networks nearby')
	none.done()
	two.done()
})

it('exits 69 when the verbs that need the network find no terminal running it', async () => {
	for (const args of [
		['allow', 'x'],
		['deny', 'x'],
		['remove', 'x'],
		['role', 'a', 'b'],
		['add', 'host'],
		['join'],
	]) {
		const h = harness({}, false)
		expect(await run(h, args), args.join(' ')).toBe(EXIT_UNAVAILABLE)
		expect(h.errors[0]?.message).toBe(
			'No Namzu terminal is running here; the network needs one open.',
		)
		h.done()
	}
})

it('says a terminal that did not answer is unavailable, and any other failure is a failure', async () => {
	const gone = harness({
		allow: async () => {
			throw new ControlError('The terminal that runs the network is not reachable.', 'unreachable')
		},
	})
	expect(await run(gone, ['allow', 'x'])).toBe(EXIT_UNAVAILABLE)
	const refused = harness({
		allow: async () => {
			throw new Error('No request to join matches that.')
		},
	})
	expect(await run(refused, ['allow', 'x'])).toBe(EXIT_FAIL)
	expect(refused.errors[0]?.message).toBe('No request to join matches that.')
	gone.done()
	refused.done()
})

it('sends to a session on another machine, and a message held there exits 4', async () => {
	const queued = harness({ send: async () => ({ status: 'queued', id: 'm1' }) })
	expect(await run(queued, ['send', 'desk-linux/swift-finch', 'hello', 'there'])).toBe(EXIT_OK)
	expect(queued.calls.find(([name]) => name === 'send')?.slice(0, 3)).toEqual([
		'send',
		'desk-linux/swift-finch',
		'hello there',
	])
	const held = harness({ send: async () => ({ status: 'held', id: 'm2' }) })
	expect(await run(held, ['send', 'desk-linux/swift-finch', 'hello'])).toBe(EXIT_HELD)
	expect(held.out[0]?.text).toContain('Held:')
	const refused = harness({ send: async () => ({ status: 'refused', reason: 'No such session.' }) })
	expect(await run(refused, ['send', 'desk-linux/x', 'hi'])).toBe(EXIT_FAIL)
	// A name that is on no machine says so; nothing was sent.
	const unknown = harness()
	expect(await run(unknown, ['send', 'desk-linux/ghost', 'hi'])).toBe(EXIT_FAIL)
	expect(unknown.out[0]?.text).toContain('No session called "desk-linux/ghost"')
	for (const h of [queued, held, refused, unknown]) h.done()
})

it('sends from a command line to a terminal in the same folder first, and to the network when it is not one', async () => {
	const h = harness({ send: async () => ({ status: 'queued', id: 'm1' }) })
	const parsed = parsePeersArgs(['send', 'swift-finch', 'hello'])
	if ('error' in parsed) throw new Error('parse')
	// No terminal here has that name, so the network is asked.
	expect(await executePeers(parsed, h.deps, h.io)).toBe(EXIT_OK)
	expect(h.calls.some(([name]) => name === 'send')).toBe(true)
	// Without a running network the old words stay.
	const off = harness({}, false)
	expect(await run(off, ['send', 'swift-finch', 'hello'])).toBe(EXIT_FAIL)
	expect(off.out[0]?.text).toContain('No matching terminal in this project')
	h.done()
	off.done()
})

it('exits 64 for a message with no text', async () => {
	const h = harness()
	expect(await run(h, ['send', 'desk-linux/x', '   '])).toBe(EXIT_USAGE)
	h.done()
})

it('prints the audit log in words, and nothing from a line it cannot read', async () => {
	const h = harness()
	const dir = join(h.deps.home, 'network')
	mkdirSync(dir, { recursive: true })
	const { writeFileSync } = await import('node:fs')
	writeFileSync(
		join(dir, 'audit.jsonl'),
		[
			JSON.stringify({
				at: 1_700_000_000_000,
				event: 'mail_held',
				machine: { id12: 'aaaaaaaaaaaa', name: 'desk-linux' },
				reason: 'modes differ',
			}),
			'garbage',
			JSON.stringify({ at: 1_700_000_060_000, event: 'role_set', session: 'aaaaaa' }),
		].join('\n'),
	)
	expect(await run(h, ['log'])).toBe(EXIT_OK)
	expect(h.out[0]?.text).toBe(
		[
			'2023-11-14 22:13:20  mail_held  desk-linux  modes differ',
			'2023-11-14 22:14:20  role_set  aaaaaa',
		].join('\n'),
	)
	expect(readAuditTail(h.deps.home, 1)).toHaveLength(1)
	expect(renderAuditLine('{"at":"x"}')).toBeUndefined()
	h.done()
})

it('parses allow --trust, networks and untrust', () => {
	expect(parsePeersArgs(['allow', '482', '913', '--trust'])).toEqual({
		verb: 'allow',
		json: false,
		query: '482913',
		trust: true,
	})
	expect(parsePeersArgs(['allow', 'desk', '--trust', '--as', 'Home'])).toMatchObject({
		trust: 'Home',
	})
	expect(parsePeersArgs(['allow', 'desk', '--as', 'Home'])).toHaveProperty('error')
	expect(parsePeersArgs(['networks'])).toEqual({ verb: 'networks', json: false })
	expect(parsePeersArgs(['networks', 'rename', 'Home', 'Office'])).toMatchObject({
		rename: ['Home', 'Office'],
	})
	expect(parsePeersArgs(['networks', 'rename', 'Home'])).toHaveProperty('error')
	expect(parsePeersArgs(['untrust', 'Home', 'wifi'])).toMatchObject({ name: 'Home wifi' })
	expect(parsePeersArgs(['untrust'])).toHaveProperty('error')
})

it('trusts a network on allow, lists trusted networks, renames and removes one', async () => {
	const home = { id: 'a1b2c3d4', name: 'Home', trustedAt: 5 }
	const h = harness({ networks: async () => [home] })
	expect(await run(h, ['allow', '482913', '--trust', '--as', 'Home'])).toBe(EXIT_OK)
	expect(h.calls.find(([name]) => name === 'allow')).toEqual(['allow', '482913', { trust: 'Home' }])
	expect(h.out[0]?.text).toContain('This network is trusted as "Home"')
	expect(h.out[0]?.text).toContain('namzu peers untrust Home')
	expect(await run(h, ['networks'])).toBe(EXIT_OK)
	expect(h.out[1]?.text).toContain('Home')
	expect(await run(h, ['networks', 'rename', 'Home', 'Office'])).toBe(EXIT_OK)
	expect(h.out[2]?.text).toContain('Renamed')
	expect(await run(h, ['untrust', 'Home'])).toBe(EXIT_OK)
	expect(h.out[3]?.text).toContain('Stopped trusting')
	h.done()
	const none = harness()
	expect(await run(none, ['networks'])).toBe(EXIT_OK)
	expect(none.out[0]?.text).toContain('No network is trusted')
	none.done()
	const off = harness({}, false)
	expect(await run(off, ['untrust', 'Home'])).toBe(EXIT_UNAVAILABLE)
	off.done()
})

it('prints a help entry that starts with its list label', async () => {
	const { peersCommand } = await import('./peers.js')
	const help = String(peersCommand.help)
	expect(help).toMatch(/^list {4}Every live Namzu session here, one counted list/m)
	expect(help).not.toMatch(/^\s+\[state\]/m)
})
