import { readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { channelFixture } from './__fixtures__/channel.js'
import { DiskPalChannelRoutes } from './routes.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
	const f = await channelFixture()
	cleanups.push(f.cleanup)
	return f
}
describe('immutable native channel route decisions', () => {
	it('has one first target winner across independent instances and preserves the winner on restart', async () => {
		const f = await fixture()
		const identity = {
			provider: f.connection.provider,
			connectionId: f.connection.connectionId,
			externalTenantId: f.event.externalTenantId,
			nativeConversationId: f.event.nativeConversationId,
			nativeChannelId: f.event.nativeChannelId,
			nativeThreadId: f.event.nativeThreadId,
		}
		const first = {
			v: 1 as const,
			revision: 1 as const,
			identity,
			recipient: f.recipient,
			profileRevision: 1,
		}
		const other = {
			...first,
			recipient: { ...f.recipient, palId: f.other.id },
		}
		const restarted = new DiskPalChannelRoutes({
			root: join(f.root, 'routes'),
		})
		const results = await Promise.allSettled([f.routes.reserve(first), restarted.reserve(other)])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const stored = await restarted.get(f.connection, identity)
		expect(stored).not.toBeNull()
		if (!stored) throw new Error('Missing winning channel route.')
		expect(await restarted.reserve(stored)).toEqual(stored)
		await expect(restarted.reserve({ ...stored, profileRevision: 2 })).rejects.toThrow(
			'immutable Pal target',
		)
	})
	it('includes tenant, provider, connection and full native tuple without path interpolation', async () => {
		const f = await fixture()
		await f.ingress.accept({
			...f.event,
			nativeConversationId: '../opaque/conversation',
		})
		const identity = {
			provider: f.connection.provider,
			connectionId: f.connection.connectionId,
			externalTenantId: f.event.externalTenantId,
			nativeConversationId: '../opaque/conversation',
			nativeChannelId: f.event.nativeChannelId,
			nativeThreadId: f.event.nativeThreadId,
		}
		expect(await f.routes.get(f.connection, identity)).not.toBeNull()
		await expect(
			f.routes.get({ ...f.connection, connectionId: 'other' }, identity),
		).rejects.toThrow('Foreign')
		expect(
			await f.routes.get(
				{ ...f.connection, provider: 'other' },
				{ ...identity, provider: 'other' },
			),
		).toBeNull()
	})
	it.skipIf(process.platform === 'win32')(
		'rejects a symlink root before reading any route decision',
		async () => {
			const f = await fixture()
			const alias = join(f.root, 'alias')
			await symlink(join(f.root, 'routes'), alias, 'dir')
			expect(() => new DiskPalChannelRoutes({ root: alias })).toThrow('without aliases')
		},
	)
	it.skipIf(process.platform === 'win32')(
		'rejects redirected immutable commits before reading a route',
		async () => {
			const f = await fixture()
			await f.ingress.accept(f.event)
			const key = (await readdir(join(f.root, 'routes')))[0]
			if (!key) throw new Error('Missing route decision path')
			const revisions = join(f.root, 'routes', key, 'revisions')
			await symlink(join(revisions, '1.json'), join(revisions, '2.json'))
			await expect(f.ingress.accept({ ...f.event, eventId: 'other-event' })).rejects.toThrow(
				'commits must be real files',
			)
		},
	)
})
