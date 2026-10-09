import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PalCommunicationView } from '../shared/pal-communication-protocol.js'
import { PalCommunicationContent, messageStatus, sentTime } from './pal-communication-dialog.js'
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
	messages: [
		...['pending', 'claimed', 'recorded'].map((status) => ({
			id: `private-message-${status}`,
			status: status as 'pending' | 'claimed' | 'recorded',
			sourceKind: 'pal' as const,
			sourcePalId: 'private-peer-id',
			conversationId: 'private-conversation',
		})),
		{
			id: 'private-owner-message',
			status: 'pending' as const,
			sourceKind: 'operator-conversation' as const,
			operatorSessionId: 'private-operator-session',
			receivedAt: Date.UTC(2026, 9, 9, 6, 53),
			text: 'Please summarise the README <b>now</b>.',
		},
	],
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
const html = (
	tab: 'general' | 'peers' | 'inbox' | 'subscriptions',
	failed = false,
	currentView = view,
	settings?: Parameters<typeof PalCommunicationContent>[0]['settings'],
) =>
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
			settings,
			conversationTitle: (id: string) =>
				id === 'private-operator-session' ? 'Check the build' : undefined,
		}),
	)
it('shows directed outgoing and read-only incoming consent in plain words', () => {
	const result = html('peers')
	expect(result).toContain('Let One message &lt;Two&gt;')
	expect(result).toContain('&lt;Two&gt; cannot message One')
	expect(result).toContain('never starts a Pal')
	expect(result).not.toContain('private-')
	expect(html('peers', true)).toContain('disabled=""')
	// App-styled switches, not bare browser checkboxes.
	expect(result).toContain('role="switch"')
	expect(result).toContain('settings-switch')
})
it('says where each message is without claiming the Pal read or answered it', () => {
	const result = html('inbox')
	for (const label of [
		'Waiting for One to read it',
		'One is picking it up',
		'Delivered to One’s conversation',
	])
		expect(result).toContain(label)
	expect(result).toContain('reads a message the next time it runs')
	expect(result).not.toMatch(/Pending|Claimed|Recorded|receipts|model read/)
	expect(result).not.toContain('private-')
})
it('lets the owner read back what they sent, from which conversation and when', () => {
	const result = html('inbox')
	expect(result).toContain('From your conversation “Check the build”')
	// Rendered as text, escaped, never as markup.
	expect(result).toContain('Please summarise the README &lt;b&gt;now&lt;/b&gt;.')
	expect(result).not.toContain('<b>now</b>')
	expect(result).toContain('<time dateTime="2026-10-09T06:53:00.000Z">')
	expect(result).toContain('<blockquote class="pal-communication-message">')
})
it('keeps a Pal-to-Pal message body out of the view', () => {
	const result = html('inbox')
	expect(result.match(/pal-communication-message/g)?.length).toBe(1)
})
it('formats a missing or invalid time as nothing rather than a wrong date', () => {
	expect(sentTime(undefined)).toBeUndefined()
	expect(sentTime(Number.NaN)).toBeUndefined()
	expect(sentTime(Date.UTC(2026, 9, 9, 6, 53))?.iso).toBe('2026-10-09T06:53:00.000Z')
	expect(messageStatus('pending', 'Işık')).toBe('Waiting for Işık to read it')
})
it('shows pinned source and consent/progress truth without exposing stored identifiers as labels', () => {
	const result = html('subscriptions')
	expect(result).toContain('Real source plan')
	expect(result).toContain('Starting the other Pal: blocked')
	expect(result).toContain('Shared up to activity 12')
	expect(result).not.toContain('>private-')
	expect(result).not.toContain('private-token')
	expect(result).not.toContain('private-subscription')
})
it('themes the pickers instead of using the browser’s own select menus', () => {
	const result = html('subscriptions')
	expect(result).not.toContain('<select')
	expect(result).toContain('data-slot="select-trigger"')
})
it('renders a real enabled form submit control for a known source and recipient', () => {
	const currentView = structuredClone(view)
	currentView.sources[0]?.conversations.push({
		id: 'own-source-conversation',
		title: 'Own source plan',
		profileRevision: 1,
	})
	const result = html('subscriptions', false, currentView)
	const submit = result.match(/<button\b[^>]*type="submit"[^>]*>Start sharing<\/button>/)?.[0]
	expect(submit).toBeDefined()
	expect(submit).not.toContain('disabled=')
	expect(html('subscriptions', true, currentView)).toMatch(
		/<button\b[^>]*type="submit"[^>]*disabled=""[^>]*>Start sharing<\/button>/,
	)
})
it('opens on a General tab that says the status and offers pause, change and delete', () => {
	const settings = {
		pal: { id: 'private-own-id', name: 'One', paused: true, model: null },
		onCustomize: () => {},
		onTogglePause: () => {},
		onDelete: () => {},
	}
	const result = html('general', false, view, settings)
	expect(result).toContain('Paused. It will not answer until you resume it.')
	expect(result).toContain('Your default model')
	expect(result).toContain('Resume One')
	expect(result).toContain('Change name, look or model')
	expect(result).toContain('Delete One')
	expect(result).not.toContain('Communication')
})
