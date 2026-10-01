import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { generateSessionId, generateTenantId } from '../../utils/id.js'
import { DiskPalMessagePolicy, PalMessagePermissionConflictError } from './policy.js'
import type { PalAddress, PalAuthorizationRequest } from './types.js'

const temporary: string[] = []
afterEach(() => {
	for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-pal-policy-'))
	temporary.push(root)
	const tenantId = generateTenantId()
	const source: PalAddress = { tenantId, palId: randomUUID() }
	const recipient: PalAddress = { tenantId, palId: randomUUID() }
	const path = join(root, 'policy')
	const policy = new DiskPalMessagePolicy({ root: path })
	const request: PalAuthorizationRequest = {
		phase: 'send',
		source: { address: source, conversationId: generateSessionId(), profileRevision: 1 },
		recipient,
		routeKey: {
			v: 1,
			kind: 'pal',
			sender: source,
			senderConversationId: generateSessionId(),
			recipient,
			dialogKey: 'default',
		},
		body: 'Explicit shared text',
		replyTo: null,
	}
	return { root, path, source, recipient, request, policy }
}
it('denies missing grants, keeps directions separate and requires explicit wake consent', async () => {
	const f = fixture()
	expect((await f.policy.authorize(f.request)).allow).toBe(false)
	const rule = await f.policy.update({
		source: f.source,
		recipient: f.recipient,
		expectedRevision: 0,
		enabled: true,
		allowWake: false,
	})
	expect((await f.policy.authorize(f.request)).allow).toBe(true)
	expect((await f.policy.authorize({ ...f.request, phase: 'deliver' })).allow).toBe(true)
	expect((await f.policy.authorize({ ...f.request, phase: 'wake' })).allow).toBe(false)
	expect(await f.policy.get(f.recipient, f.source)).toBeNull()
	expect(await f.policy.outgoing(f.source)).toEqual([rule])
	expect(await f.policy.outgoing(f.recipient)).toEqual([])
	await f.policy.update({
		source: f.source,
		recipient: f.recipient,
		expectedRevision: 1,
		enabled: true,
		allowWake: true,
	})
	expect(await f.policy.authorize({ ...f.request, phase: 'wake' })).toMatchObject({
		allow: true,
		grant: { revision: '2' },
	})
})
it('observes revocation across restarts and refuses concurrent stale permission updates', async () => {
	const f = fixture()
	await f.policy.update({
		source: f.source,
		recipient: f.recipient,
		expectedRevision: 0,
		enabled: true,
		allowWake: true,
	})
	const peer = new DiskPalMessagePolicy({ root: f.path })
	const outcomes = await Promise.allSettled([
		f.policy.update({
			source: f.source,
			recipient: f.recipient,
			expectedRevision: 1,
			enabled: false,
			allowWake: false,
		}),
		peer.update({
			source: f.source,
			recipient: f.recipient,
			expectedRevision: 1,
			enabled: false,
			allowWake: false,
		}),
	])
	expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
	const failure = outcomes.find((value) => value.status === 'rejected') as PromiseRejectedResult
	expect(failure.reason).toBeInstanceOf(PalMessagePermissionConflictError)
	const restarted = new DiskPalMessagePolicy({ root: f.path })
	expect((await restarted.authorize(f.request)).allow).toBe(false)
	expect((await f.policy.authorize(f.request)).allow).toBe(false)
	expect(await restarted.outgoing(f.source)).toEqual([])
	expect(await restarted.get(f.source, f.recipient)).toMatchObject({ revision: 2, enabled: false })
})
it('captures update inputs before disk IO and freezes returned identities', async () => {
	const f = fixture()
	const source = { ...f.source }
	const recipient = { ...f.recipient }
	const input = { source, recipient, expectedRevision: 0, enabled: true, allowWake: false }
	const pending = f.policy.update(input)
	source.palId = randomUUID()
	recipient.palId = randomUUID()
	input.enabled = false
	input.allowWake = true
	const rule = await pending
	expect(rule).toMatchObject({
		source: f.source,
		recipient: f.recipient,
		enabled: true,
		allowWake: false,
	})
	expect(Object.isFrozen(rule.source)).toBe(true)
	expect(Object.isFrozen(rule.recipient)).toBe(true)
	expect((await f.policy.authorize(f.request)).allow).toBe(true)
	expect(await f.policy.get(source, recipient)).toBeNull()
})
it('refuses cross-tenant grants and directory aliases', async () => {
	const f = fixture()
	await expect(
		f.policy.update({
			source: f.source,
			recipient: { ...f.recipient, tenantId: generateTenantId() },
			expectedRevision: 0,
			enabled: true,
			allowWake: false,
		}),
	).rejects.toThrow('Cross-tenant')
	const alias = join(f.root, 'alias')
	symlinkSync(f.path, alias, process.platform === 'win32' ? 'junction' : 'dir')
	expect(() => new DiskPalMessagePolicy({ root: alias })).toThrow('real directories')
	await expect(
		f.policy.authorize({ ...f.request, phase: 'unsupported' as 'send' }),
	).rejects.toThrow('phase')
})
