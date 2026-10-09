import {
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskPalActivitySubscriptionPolicy,
	DiskPalActivitySubscriptionStore,
	DiskPalCommunicationStore,
	DiskPalMessagePolicy,
	PalMessageBroker,
	PalOperatorMessageBroker,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CliAcpRuntime } from '../commands/acp.js'
import { createDesktopHostExtensions } from '../commands/desktop-host.js'
import {
	closeSessions,
	openConversationLog,
	openSessions,
	setTitle,
} from '../integrations/sessions/store.js'
import * as sessionStorage from '../integrations/sessions/store.js'
import { isTrusted, isTrustedAtStateRoot, trustDir } from '../integrations/trust/store.js'
import {
	cliPalActivitySubscriptionStore,
	cliPalCommunicationPolicy,
	cliPalCommunicationStore,
	createCliOperatorIngressAuthorization,
	createCliPalMessageHost,
} from './communication.js'
import { claimPalConversation } from './conversations.js'
import * as environment from './environment.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

let root: string
let home: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-communication-'))
	home = join(root, 'state')
	mkdirSync(home)
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
const host = (cwd: string) => createDesktopHostExtensions({} as CliAcpRuntime, cwd)
async function fixture() {
	const source = createPal({ name: 'Research', purpose: 'PRIVATE_PURPOSE' })
	const recipient = createPal({
		name: 'Review',
		model: { provider: 'PRIVATE_PROVIDER', model: 'PRIVATE_MODEL' },
	})
	const stranger = createPal({ name: 'Unrelated' })
	const sessionId = generateSessionId()
	await claimPalConversation(source.workspace, source.id, sessionId)
	return {
		source,
		recipient,
		stranger,
		sessionId,
		own: host(source.workspace),
		other: host(recipient.workspace),
	}
}
const update = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) =>
	f.own['namzu/pals/communication/permissions/update']({
		palId: f.source.id,
		peerPalId: f.recipient.id,
		expectedRevision: 0,
		enabled: true,
		allowWake: false,
		...extra,
	})
const createSubscription = (
	f: Awaited<ReturnType<typeof fixture>>,
	extra: Record<string, unknown> = {},
) =>
	f.other['namzu/pals/communication/subscriptions/create']({
		palId: f.recipient.id,
		sourcePalId: f.source.id,
		sourceSessionId: f.sessionId,
		recipientPalId: f.recipient.id,
		wake: false,
		...extra,
	})

it('registers all six metadata-only methods and exposes known peers without execution or private profiles', async () => {
	const f = await fixture()
	const start = vi.spyOn(environment, 'getCliPalRuntime')
	const methods = Object.keys(f.own).filter((name) => name.startsWith('namzu/pals/communication/'))
	expect(methods).toHaveLength(6)
	const result = await f.own['namzu/pals/communication/peers']({ palId: f.source.id })
	expect(result).toEqual({
		v: 1,
		palId: f.source.id,
		peers: [f.recipient, f.stranger]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((pal) => ({
				palId: pal.id,
				name: pal.name,
				paused: false,
				outgoing: { revision: 0, enabled: false, allowWake: false },
				incoming: { revision: 0, enabled: false, allowWake: false },
			})),
	})
	expect(JSON.stringify(result)).not.toContain('PRIVATE_')
	expect(JSON.stringify(result)).not.toContain(root)
	expect(start).not.toHaveBeenCalled()
})

it('updates only the current Pal’s outgoing consent, treats wake separately, and refuses stale revisions', async () => {
	const f = await fixture()
	expect(await update(f)).toMatchObject({
		v: 1,
		palId: f.source.id,
		peerPalId: f.recipient.id,
		permission: { revision: 1, enabled: true, allowWake: false },
	})
	await expect(update(f)).rejects.toThrow('consent changed')
	const incoming = await f.other['namzu/pals/communication/peers']({ palId: f.recipient.id })
	expect(incoming.peers.find((peer) => peer.palId === f.source.id)).toMatchObject({
		incoming: { revision: 1, enabled: true, allowWake: false },
		outgoing: { revision: 0, enabled: false, allowWake: false },
	})
	await expect(update(f, { expectedRevision: 1, enabled: false, allowWake: true })).rejects.toThrow(
		'Wake',
	)
	expect(await update(f, { expectedRevision: 1, enabled: false })).toMatchObject({
		permission: { revision: 2, enabled: false, allowWake: false },
	})
})

it('refuses foreign/ordinary scopes and untrusted or injected mutation parameters', async () => {
	const f = await fixture()
	await expect(f.own['namzu/pals/communication/peers']({ palId: f.recipient.id })).rejects.toThrow(
		'own',
	)
	const ordinary = join(root, 'ordinary')
	mkdirSync(ordinary)
	const untrusted = host(ordinary)
	await expect(
		untrusted['namzu/pals/communication/inbox']({ palId: f.source.id }),
	).rejects.toThrow()
	trustDir(ordinary)
	await expect(untrusted['namzu/pals/communication/inbox']({ palId: f.source.id })).rejects.toThrow(
		'own',
	)
	for (const extra of [
		{ allowWake: 'false' },
		{ tenantId: 'forged' },
		{ expectedRevision: -1 },
		{ body: 'PRIVATE_' },
	]) {
		await expect(update(f, extra)).rejects.toThrow()
	}
	expect(
		(await f.own['namzu/pals/communication/peers']({ palId: f.source.id })).peers.every(
			(peer) => !peer.outgoing.enabled,
		),
	).toBe(true)
})

it('returns only accepted delivery metadata from a genuine broker message, never its body or receipt', async () => {
	const f = await fixture()
	await update(f)
	const state = await openSessions(f.source.workspace)
	try {
		const policy = cliPalCommunicationPolicy()
		const broker = new PalMessageBroker({
			pals: getCliPalStore(),
			store: cliPalCommunicationStore(),
			host: createCliPalMessageHost(),
			authorize: policy.authorize.bind(policy),
		})
		const accepted = await broker
			.sender({
				address: { tenantId: state.tenantId, palId: f.source.id },
				conversationId: f.sessionId,
				profileRevision: 1,
			})
			.send({
				operationId: 'native-metadata-test',
				recipient: { tenantId: state.tenantId, palId: f.recipient.id },
				body: 'PRIVATE_MESSAGE_BODY',
			})
		const result = await f.other['namzu/pals/communication/inbox']({ palId: f.recipient.id })
		expect(result).toEqual({
			v: 1,
			palId: f.recipient.id,
			messages: [
				{
					id: accepted.id,
					status: 'pending',
					receivedAt: expect.any(Number),
					conversationId: accepted.sessionId,
					sourceKind: 'pal',
					sourcePalId: f.source.id,
				},
			],
		})
		expect(JSON.stringify(result)).not.toContain('PRIVATE_')
		expect(JSON.stringify(result)).not.toContain('digest')
		expect(JSON.stringify(result)).not.toContain('claim')
	} finally {
		closeSessions(state)
	}
})

it('lets the owner read back a message they sent from a conversation, with its time, and keeps Pal bodies private', async () => {
	const f = await fixture()
	const state = await openSessions(f.recipient.workspace)
	try {
		const operatorSession = generateSessionId()
		const sent = await new PalOperatorMessageBroker({
			pals: getCliPalStore(),
			store: cliPalCommunicationStore(),
			authorize: createCliOperatorIngressAuthorization(),
			now: () => 1_700_000_000_000,
		}).send(
			{ tenantId: state.tenantId, sessionId: operatorSession },
			{
				operationId: 'owner-readback',
				recipient: { tenantId: state.tenantId, palId: f.recipient.id },
				body: 'Please summarise the README.',
			},
		)
		const result = await f.other['namzu/pals/communication/inbox']({ palId: f.recipient.id })
		expect(result.messages).toEqual([
			expect.objectContaining({
				id: sent.id,
				status: 'pending',
				sourceKind: 'operator-conversation',
				operatorSessionId: operatorSession,
				receivedAt: 1_700_000_000_000,
				text: 'Please summarise the README.',
			}),
		])
	} finally {
		closeSessions(state)
	}
})

it('creates pinned original activity subscriptions and disables only a participant with the exact revision', async () => {
	const f = await fixture()
	updatePal(f.source.id, f.source.revision, { name: 'Renamed', paused: true })
	const created = await createSubscription(f)
	expect(created.subscription).toMatchObject({
		v: 1,
		revision: 2,
		configurationRevision: 2,
		sourcePalId: f.source.id,
		sourceConversationId: f.sessionId,
		sourceProfileRevision: 1,
		recipientPalId: f.recipient.id,
		enabled: true,
		permission: { revision: 1, observe: true, disclose: true, receive: true, wake: false },
		progress: { lastSequence: null },
	})
	const listed = await f.other['namzu/pals/communication/subscriptions/list']({
		palId: f.recipient.id,
	})
	expect(listed.subscriptions).toEqual([created.subscription])
	expect(listed.sources.find((source) => source.palId === f.source.id)?.conversations).toEqual([
		{ id: f.sessionId, title: 'New conversation', profileRevision: 1 },
	])
	expect(JSON.stringify(listed)).not.toContain('PRIVATE_')
	expect(JSON.stringify(listed)).not.toContain('cursor')
	await expect(
		f.other['namzu/pals/communication/subscriptions/disable']({
			palId: f.recipient.id,
			id: created.subscription.id,
			expectedRevision: 1,
		}),
	).rejects.toThrow('consent changed')
	await expect(
		host(f.stranger.workspace)['namzu/pals/communication/subscriptions/disable']({
			palId: f.stranger.id,
			id: created.subscription.id,
			expectedRevision: 2,
		}),
	).rejects.toThrow('own')
	expect(
		await f.other['namzu/pals/communication/subscriptions/disable']({
			palId: f.recipient.id,
			id: created.subscription.id,
			expectedRevision: 2,
		}),
	).toMatchObject({ subscription: { enabled: false, revision: 3 } })
})

it('shows only explicit user names from original journals and keeps derived prompt titles private', async () => {
	const f = await fixture()
	const state = await openSessions(f.source.workspace)
	try {
		const log = openConversationLog(state, f.sessionId)
		const lease = await log.claim({ holder: 'source-title-fixture', ttlMs: 30_000 })
		if (!lease) throw new Error('Could not claim fixture journal')
		try {
			await log.append(lease, {
				type: 'session_updated',
				title: 'PRIVATE_PROMPT_DERIVED_TITLE',
				titleSource: 'derived',
			})
		} finally {
			await log.release(lease)
		}
		const list = () =>
			f.other['namzu/pals/communication/subscriptions/list']({ palId: f.recipient.id })
		const derived = await list()
		expect(derived.sources.find((source) => source.palId === f.source.id)?.conversations).toEqual([
			{ id: f.sessionId, title: 'New conversation', profileRevision: 1 },
		])
		expect(JSON.stringify(derived)).not.toContain('PRIVATE_PROMPT_DERIVED_TITLE')
		await setTitle(state, f.sessionId, 'Named research')
		expect(
			(await list()).sources.find((source) => source.palId === f.source.id)?.conversations,
		).toEqual([{ id: f.sessionId, title: 'Named research', profileRevision: 1 }])
		await setTitle(state, f.sessionId, '')
		expect(
			(await list()).sources.find((source) => source.palId === f.source.id)?.conversations,
		).toEqual([{ id: f.sessionId, title: 'New conversation', profileRevision: 1 }])
	} finally {
		closeSessions(state)
	}
})

it('refuses a substituted source conversation and a subscription between two unrelated Pals before writes', async () => {
	const f = await fixture()
	await expect(createSubscription(f, { sourcePalId: f.recipient.id })).rejects.toThrow()
	await expect(
		host(f.stranger.workspace)['namzu/pals/communication/subscriptions/create']({
			palId: f.stranger.id,
			sourcePalId: f.source.id,
			sourceSessionId: f.sessionId,
			recipientPalId: f.recipient.id,
			wake: false,
		}),
	).rejects.toThrow('participant')
	expect(await cliPalActivitySubscriptionStore().list()).toEqual([])
})

it('retains a disabled subscription after partial setup and redacts the storage failure', async () => {
	const f = await fixture()
	const denied = vi
		.spyOn(DiskPalActivitySubscriptionPolicy.prototype, 'update')
		.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_REASON'))
	await expect(createSubscription(f)).rejects.toThrow('change could not be confirmed')
	denied.mockRestore()
	const rows = await cliPalActivitySubscriptionStore().list()
	expect(rows).toHaveLength(1)
	expect(rows[0]?.enabled).toBe(false)
	const result = await f.other['namzu/pals/communication/subscriptions/list']({
		palId: f.recipient.id,
	})
	expect(result.subscriptions[0]).toMatchObject({ enabled: false, revision: 1, permission: null })
})

it('pins input and all store lookups to the authenticated home across an awaited home change', async () => {
	const f = await fixture()
	const replacement = join(root, 'replacement-state')
	mkdirSync(replacement)
	vi.stubEnv('NAMZU_HOME', replacement)
	const foreign = createPal({ name: 'PRIVATE_FOREIGN_HOME' })
	vi.stubEnv('NAMZU_HOME', home)
	const params = {
		palId: f.source.id,
		peerPalId: f.recipient.id,
		expectedRevision: 0,
		enabled: true,
		allowWake: false,
	}
	const original = sessionStorage.openSessions
	vi.spyOn(sessionStorage, 'openSessions').mockImplementation(async (...args) => {
		const state = await original(...args)
		vi.stubEnv('NAMZU_HOME', replacement)
		params.peerPalId = foreign.id
		return state
	})
	expect(await f.own['namzu/pals/communication/permissions/update'](params)).toMatchObject({
		peerPalId: f.recipient.id,
		permission: { revision: 1 },
	})
	const state = await original(f.source.workspace, { stateRoot: home })
	try {
		expect(
			await cliPalCommunicationPolicy(home).get(
				{ tenantId: state.tenantId, palId: f.source.id },
				{ tenantId: state.tenantId, palId: f.recipient.id },
			),
		).toMatchObject({ enabled: true })
	} finally {
		closeSessions(state)
	}
})

it('refuses a stale own profile at the read boundary instead of publishing a misleading snapshot', async () => {
	const f = await fixture()
	const get = DiskPalMessagePolicy.prototype.get
	vi.spyOn(DiskPalMessagePolicy.prototype, 'get').mockImplementationOnce(async function (
		this: DiskPalMessagePolicy,
		...args
	) {
		const result = await get.apply(this, args)
		updatePal(f.source.id, f.source.revision, { name: 'Changed while reading' })
		return result
	})
	await expect(f.own['namzu/pals/communication/peers']({ palId: f.source.id })).rejects.toThrow(
		'context changed',
	)
})

it('refuses a peer profile that changes while its permission metadata is being read', async () => {
	const f = await fixture()
	const get = DiskPalMessagePolicy.prototype.get
	vi.spyOn(DiskPalMessagePolicy.prototype, 'get').mockImplementationOnce(async function (
		this: DiskPalMessagePolicy,
		...args
	) {
		const result = await get.apply(this, args)
		updatePal(f.recipient.id, f.recipient.revision, { name: 'Changed peer while reading' })
		return result
	})
	await expect(f.own['namzu/pals/communication/peers']({ palId: f.source.id })).rejects.toThrow(
		'Pal changed',
	)
})

it('refuses an old connection after a physical home replacement even when copied Pal IDs and revisions match', async () => {
	const f = await fixture()
	await f.own['namzu/pals/communication/peers']({ palId: f.source.id })
	vi.spyOn(DiskPalCommunicationStore.prototype, 'readIngress').mockRejectedValueOnce(
		new Error('PRIVATE_METADATA_READ_FAILURE'),
	)
	await expect(f.own['namzu/pals/communication/inbox']({ palId: f.source.id })).rejects.toThrow(
		'records could not be read completely',
	)
	const replacement = join(root, 'copied-home')
	cpSync(home, replacement, {
		recursive: true,
		filter(source, destination) {
			// cp defaults new directories to 755; keep the real private-store permissions.
			const stat = lstatSync(source)
			if (stat.isDirectory()) mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 })
			return true
		},
	})
	renameSync(home, join(root, 'original-home'))
	renameSync(replacement, home)
	await expect(update(f)).rejects.toThrow('reconnect')
	const fresh = host(f.source.workspace)
	expect(
		(await fresh['namzu/pals/communication/peers']({ palId: f.source.id })).peers.every(
			(peer) => !peer.outgoing.enabled,
		),
	).toBe(true)
	expect(
		await fresh['namzu/pals/communication/permissions/update']({
			palId: f.source.id,
			peerPalId: f.recipient.id,
			expectedRevision: 0,
			enabled: true,
			allowWake: false,
		}),
	).toMatchObject({ permission: { revision: 1, enabled: true } })
})

it('rejects incomplete subscription/source snapshots with no private journal or storage error text', async () => {
	const f = await fixture()
	const created = await createSubscription(f)
	const file = join(
		home,
		'pal-activity-subscriptions',
		created.subscription.id,
		'revisions',
		'2.json',
	)
	const saved = readFileSync(file, 'utf8')
	writeFileSync(file, '{PRIVATE_BAD_RECORD')
	await expect(
		f.other['namzu/pals/communication/subscriptions/list']({ palId: f.recipient.id }),
	).rejects.toThrow('records could not be read completely')
	writeFileSync(file, saved)
	const state = await openSessions(f.source.workspace)
	try {
		writeFileSync(state.paths.sessionLog({ sessionId: f.sessionId }), '\nPRIVATE_BROKEN_JOURNAL', {
			flag: 'a',
		})
		await expect(
			f.other['namzu/pals/communication/subscriptions/list']({ palId: f.recipient.id }),
		).rejects.toThrow('records could not be read completely')
	} finally {
		closeSessions(state)
	}
})

it('leaves an already created subscription disabled if the current Pal changes before enablement', async () => {
	const f = await fixture()
	const create = DiskPalActivitySubscriptionStore.prototype.create
	vi.spyOn(DiskPalActivitySubscriptionStore.prototype, 'create').mockImplementationOnce(
		async function (this: DiskPalActivitySubscriptionStore, input) {
			const result = await create.call(this, input)
			updatePal(f.recipient.id, f.recipient.revision, { name: 'Changed during setup' })
			return result
		},
	)
	await expect(createSubscription(f)).rejects.toThrow('context changed')
	expect((await cliPalActivitySubscriptionStore().list())[0]).toMatchObject({
		enabled: false,
		revision: 1,
	})
})

it('refuses an indexed source journal that disappears after capture instead of silently clearing the selector', async () => {
	const f = await fixture()
	const original = sessionStorage.openSessions
	vi.spyOn(sessionStorage, 'openSessions').mockImplementation(async (...args) => {
		const state = await original(...args)
		if (state.projectRoot === f.source.workspace) {
			const list = state.index.listSessions.bind(state.index)
			state.index.listSessions = async (...input) => {
				const rows = await list(...input)
				const log = state.paths.sessionLog({ sessionId: f.sessionId })
				renameSync(log, `${log}.removed-after-index`)
				return rows
			}
		}
		return state
	})
	await expect(
		f.other['namzu/pals/communication/subscriptions/list']({ palId: f.recipient.id }),
	).rejects.toThrow('records could not be read completely')
})

it('preserves the explicit OS-home trust seam alongside captured application-root trust', () => {
	const cwd = join(root, 'explicitly-trusted')
	mkdirSync(cwd)
	const osHome = join(root, 'os-home')
	trustDir(cwd, osHome)
	expect(isTrusted(cwd, osHome)).toBe(true)
	expect(isTrustedAtStateRoot(cwd, join(osHome, '.namzu'))).toBe(true)
	expect(isTrustedAtStateRoot(cwd, home)).toBe(false)
})
