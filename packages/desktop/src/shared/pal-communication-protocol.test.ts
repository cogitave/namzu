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
it('admits a message from the owner conversation as its own source and keeps only metadata', () => {
	const [message] = readPalInbox(
		{
			v: 1,
			palId: 'one',
			messages: [
				{
					id: 'message',
					status: 'pending',
					sourceKind: 'operator-conversation',
					operatorSessionId: 'session',
					body: 'PRIVATE',
				},
			],
		},
		'one',
	)
	expect(message).toEqual({
		id: 'message',
		status: 'pending',
		sourceKind: 'operator-conversation',
		operatorSessionId: 'session',
	})
})
it('keeps what the owner wrote and when, but never the text of a Pal or channel message', () => {
	const messages = readPalInbox(
		{
			v: 1,
			palId: 'one',
			messages: [
				{
					id: 'owner',
					status: 'pending',
					sourceKind: 'operator-conversation',
					operatorSessionId: 'session',
					receivedAt: 1_700_000_000_000,
					text: 'Please summarise the README.',
				},
				{ id: 'pal', status: 'pending', sourceKind: 'pal', sourcePalId: 'two', text: 'PRIVATE' },
				{ id: 'channel', status: 'recorded', sourceKind: 'channel', text: 'PRIVATE' },
			],
		},
		'one',
	)
	expect(messages[0]).toMatchObject({
		receivedAt: 1_700_000_000_000,
		text: 'Please summarise the README.',
	})
	expect(JSON.stringify(messages.slice(1))).not.toContain('PRIVATE')
})
