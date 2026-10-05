import { expect, it } from 'vitest'
import { readPalInbox, readPalPeers, readPalSubscriptions } from './pal-communication-protocol.js'
const permission = { revision: 0, enabled: false, allowWake: false }
it('admits only the exact participant and public metadata, defensively copying permission fields', () => {
	const peer = {
		palId: 'two',
		name: 'Two',
		paused: false,
		outgoing: permission,
		incoming: permission,
		purpose: 'PRIVATE',
	}
	const peers = readPalPeers({ v: 1, palId: 'one', peers: [peer] }, 'one')
	expect(JSON.stringify(peers)).not.toContain('PRIVATE')
	permission.revision = 2
	expect(peers[0]?.incoming.revision).toBe(0)
	permission.revision = 0
	expect(() => readPalPeers({ v: 1, palId: 'other', peers: [peer] }, 'one')).toThrow('Foreign')
	expect(() => readPalPeers({ v: 1, palId: 'one', peers: [peer, peer] }, 'one')).toThrow(
		'Duplicate',
	)
	const messages = readPalInbox(
		{
			v: 1,
			palId: 'one',
			messages: [
				{
					id: 'message',
					status: 'recorded',
					sourceKind: 'pal',
					sourcePalId: 'two',
					body: 'PRIVATE',
					receipt: 'PRIVATE',
				},
			],
		},
		'one',
	)
	expect(JSON.stringify(messages)).not.toContain('PRIVATE')
})
it('rejects a complete list on one malformed row rather than treating it as empty or successful delivery', () => {
	expect(() =>
		readPalInbox(
			{ v: 1, palId: 'one', messages: [{ id: 'message', status: 'completed', sourceKind: 'pal' }] },
			'one',
		),
	).toThrow('phase')
	expect(() =>
		readPalSubscriptions(
			{
				v: 1,
				palId: 'one',
				subscriptions: [{ v: 1, sourcePalId: 'foreign', recipientPalId: 'foreign' }],
				sources: [],
			},
			'one',
		),
	).toThrow('Foreign')
})
