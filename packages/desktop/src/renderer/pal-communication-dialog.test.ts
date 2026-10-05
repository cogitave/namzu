import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PalCommunicationView } from '../shared/pal-communication-protocol.js'
import { PalCommunicationContent } from './pal-communication-dialog.js'
const view: PalCommunicationView = {
	palId: 'private-own-id',
	snapshotId: 'private-token',
	supported: true,
	peers: [
		{
			palId: 'private-peer-id',
			name: '<Two>',
			paused: false,
			outgoing: { revision: 1, enabled: true, allowWake: false },
			incoming: { revision: 0, enabled: false, allowWake: false },
		},
	],
	messages: ['pending', 'claimed', 'recorded'].map((status) => ({
		id: `private-message-${status}`,
		status: status as 'pending' | 'claimed' | 'recorded',
		sourceKind: 'pal',
		sourcePalId: 'private-peer-id',
		conversationId: 'private-conversation',
	})),
	subscriptions: [
		{
			v: 1,
			id: 'private-subscription',
			revision: 2,
			configurationRevision: 1,
			sourcePalId: 'private-peer-id',
			sourceConversationId: 'private-source-conversation',
			sourceProfileRevision: 3,
			recipientPalId: 'private-own-id',
			enabled: true,
			permission: { revision: 1, observe: true, disclose: true, receive: true, wake: false },
			progress: { lastSequence: 12 },
		},
	],
	sources: [
		{ palId: 'private-own-id', name: 'One', conversations: [] },
		{
			palId: 'private-peer-id',
			name: '<Two>',
			conversations: [
				{ id: 'private-source-conversation', title: 'Real source plan', profileRevision: 3 },
			],
		},
	],
}
const html = (tab: 'peers' | 'inbox' | 'subscriptions', failed = false, currentView = view) =>
	renderToStaticMarkup(
		createElement(PalCommunicationContent, {
			pal: { id: 'private-own-id', name: 'One' },
			state: {
				view: currentView,
				loading: false,
				busy: false,
				needsRefresh: failed,
				...(failed ? { error: 'Refresh before making changes.' } : {}),
			},
			onPermission: () => {},
			onCreate: () => {},
			onDisable: () => {},
			tab,
		}),
	)
it('shows directed outgoing and read-only incoming consent without promising automatic idle work', () => {
	const result = html('peers')
	expect(result).toContain('Allow One to message &lt;Two&gt;')
	expect(result).toContain('Messages from &lt;Two&gt; are blocked')
	expect(result).toContain('Automatic idle turns are not available yet')
	expect(result).not.toContain('private-')
	expect(html('peers', true)).toContain('disabled=""')
})
it('distinguishes pending, reserved and recorded inputs from an answered or successful task', () => {
	const result = html('inbox')
	for (const label of [
		'Pending',
		'Claimed',
		'Recorded',
		'Accepted · awaiting delivery',
		'Delivery reserved · recording not confirmed',
		'Recorded in conversation',
		'do not establish',
	])
		expect(result).toContain(label)
	expect(result).not.toContain('private-')
})
it('shows pinned source and consent/progress truth without exposing stored identifiers as labels', () => {
	const result = html('subscriptions')
	expect(result).toContain('Real source plan · Profile 3')
	expect(result).toContain('Idle wake: blocked')
	expect(result).toContain('Activity checked through record 12')
	// Select values carry the exact IDs required to choose a source; visible labels do not.
	expect(result).not.toContain('>private-')
	expect(result).not.toContain('private-token')
	expect(result).not.toContain('private-subscription')
})
it('renders a real enabled form submit control for a known source and recipient', () => {
	const currentView = structuredClone(view)
	currentView.sources[0]?.conversations.push({
		id: 'own-source-conversation',
		title: 'Own source plan',
		profileRevision: 1,
	})
	const result = html('subscriptions', false, currentView)
	const submit = result.match(/<button\b[^>]*type="submit"[^>]*>Add subscription<\/button>/)?.[0]
	expect(submit).toBeDefined()
	expect(submit).not.toContain('disabled=')
	expect(html('subscriptions', true, currentView)).toMatch(
		/<button\b[^>]*type="submit"[^>]*disabled=""[^>]*>Add subscription<\/button>/,
	)
})
