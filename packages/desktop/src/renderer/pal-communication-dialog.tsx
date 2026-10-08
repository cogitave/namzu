import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
	PalPermissionChange,
	PalSubscriptionCreate,
} from '../shared/pal-communication-protocol.js'
import type { DesktopApi, PalView } from '../shared/protocol.js'
import { LoaderCircleIcon, RefreshIcon, XIcon } from './icons.js'
import {
	PalCommunicationController,
	type PalCommunicationState,
} from './pal-communication-controller.js'
import { Button } from './ui/button.js'
import './pal-communication-dialog.css'

export function PalCommunicationContent({
	pal,
	state,
	onPermission,
	onCreate,
	onDisable,
	tab = 'peers',
}: {
	pal: Pick<PalView, 'id' | 'name'>
	state: PalCommunicationState
	onPermission: (value: Omit<PalPermissionChange, 'snapshotId'>) => void
	onCreate: (value: Omit<PalSubscriptionCreate, 'snapshotId'>) => void
	onDisable: (id: string) => void
	tab?: 'peers' | 'inbox' | 'subscriptions'
}) {
	const view = state.view
	const disabled = state.loading || state.busy || state.needsRefresh || !view?.supported
	const names = new Map([
		[pal.id, pal.name],
		...(view?.peers.map((peer) => [peer.palId, peer.name] as const) ?? []),
		...(view?.sources.map((source) => [source.palId, source.name] as const) ?? []),
	])
	const name = (id?: string) => (id ? (names.get(id) ?? 'Unavailable Pal') : 'Unavailable Pal')
	return (
		<Tabs.Root defaultValue={tab} className="pal-communication-tabs">
			<Tabs.List className="pal-communication-tab-list" aria-label="Communication views">
				<Tabs.Tab value="peers">Peers</Tabs.Tab>
				<Tabs.Tab value="inbox">Inbox</Tabs.Tab>
				<Tabs.Tab value="subscriptions">Activity subscriptions</Tabs.Tab>
			</Tabs.List>
			{state.error && (
				<p className="pal-communication-notice" role="alert">
					{state.error}
				</p>
			)}
			{view && !view.supported && !state.loading && (
				<output className="pal-communication-notice block">
					Communication settings are unavailable in this runtime.
				</output>
			)}
			{state.loading && (
				<output className="pal-communication-loading">
					<LoaderCircleIcon /> Loading communication…
				</output>
			)}
			{state.busy && (
				<output className="pal-communication-loading">
					<LoaderCircleIcon /> Saving change…
				</output>
			)}
			<Tabs.Panel value="peers" className="pal-communication-panel">
				<p className="pal-communication-help">
					Choose who {pal.name} can message. Replies need a separate permission in the other
					direction. Messages can be received during active work. Automatic idle turns are not
					available yet; changing these permissions does not start a turn.
				</p>
				{view?.peersNotice && (
					<p role="alert" className="pal-communication-notice">
						{view.peersNotice}
					</p>
				)}
				{view && !view.peersNotice && view.peers.length === 0 && (
					<p className="quiet">Create another Pal to manage peer communication.</p>
				)}
				<div className="pal-communication-rows">
					{view?.peers.map((peer) => (
						<section key={peer.palId} className="pal-communication-row">
							<header>
								<strong>{peer.name}</strong>
								{peer.paused && <span className="pal-communication-badge">Paused</span>}
							</header>
							<label className="pal-communication-check">
								<input
									type="checkbox"
									checked={peer.outgoing.enabled}
									disabled={disabled || !!view.peersNotice}
									onChange={(event) =>
										onPermission({
											peerPalId: peer.palId,
											enabled: event.target.checked,
											allowWake: event.target.checked && peer.outgoing.allowWake,
										})
									}
								/>
								<span>
									Allow {pal.name} to message {peer.name}
								</span>
							</label>
							<label className="pal-communication-check">
								<input
									type="checkbox"
									checked={peer.outgoing.allowWake}
									disabled={disabled || !!view.peersNotice || !peer.outgoing.enabled}
									onChange={(event) =>
										onPermission({
											peerPalId: peer.palId,
											enabled: peer.outgoing.enabled,
											allowWake: event.target.checked,
										})
									}
								/>
								<span>Allow these messages to wake {peer.name}</span>
							</label>
							<p className="pal-communication-incoming">
								{peer.incoming.enabled
									? `${peer.name} can message ${pal.name}`
									: `Messages from ${peer.name} are blocked`}
								{peer.incoming.enabled && peer.incoming.allowWake
									? ' · Incoming idle wake allowed'
									: ''}
							</p>
						</section>
					))}
				</div>
			</Tabs.Panel>
			<Tabs.Panel value="inbox" className="pal-communication-panel">
				<p className="pal-communication-help">
					Accepted inputs waiting for, or recorded in, a conversation. These receipts do not
					establish that a model read them or completed the requested work. Message bodies remain
					private.
				</p>
				{view?.inboxNotice && (
					<p role="alert" className="pal-communication-notice">
						{view.inboxNotice}
					</p>
				)}
				{view && !view.inboxNotice && view.messages.length === 0 && (
					<p className="quiet">No accepted inputs yet.</p>
				)}
				<div className="pal-communication-rows">
					{view?.messages.map((message) => (
						<article key={message.id} className="pal-communication-row">
							<header>
								<strong>
									{message.sourceKind === 'pal'
										? name(message.sourcePalId)
										: message.sourceKind === 'host-observation'
											? `Activity from ${name(message.observedPalId)}`
											: message.sourceKind === 'operator-conversation'
												? 'Message from your conversation'
												: message.provider
													? `Channel · ${message.provider}`
													: 'Channel input'}
								</strong>
								<span className="pal-communication-badge">
									{message.status === 'pending'
										? 'Pending'
										: message.status === 'claimed'
											? 'Claimed'
											: 'Recorded'}
								</span>
							</header>
							<p>
								{message.status === 'pending'
									? 'Accepted · awaiting delivery'
									: message.status === 'claimed'
										? 'Delivery reserved · recording not confirmed'
										: 'Recorded in conversation'}
							</p>
						</article>
					))}
				</div>
			</Tabs.Panel>
			<Tabs.Panel value="subscriptions" className="pal-communication-panel">
				<p className="pal-communication-help">
					Share activity updates from a selected conversation with another Pal. Adding a
					subscription allows those updates to be observed, shared and received. Idle wake is a
					separate choice. Message contents and tool results stay private.
				</p>
				{view?.subscriptionsNotice && (
					<p role="alert" className="pal-communication-notice">
						{view.subscriptionsNotice}
					</p>
				)}
				{view && (
					<SubscriptionForm
						pal={pal}
						state={state}
						disabled={disabled || !!view.subscriptionsNotice}
						onCreate={onCreate}
					/>
				)}
				<div className="pal-communication-rows">
					{view?.subscriptions.map((row) => {
						const conversation = view.sources
							.find((source) => source.palId === row.sourcePalId)
							?.conversations.find((conversation) => conversation.id === row.sourceConversationId)
						const permitted =
							row.permission?.observe && row.permission.disclose && row.permission.receive
						return (
							<article key={row.id} className="pal-communication-row">
								<header>
									<strong>
										{name(row.sourcePalId)} → {name(row.recipientPalId)}
									</strong>
									<span className="pal-communication-badge">
										{row.enabled ? (permitted ? 'Enabled' : 'Delivery blocked') : 'Disabled'}
									</span>
								</header>
								<p>
									{conversation?.title ?? 'Saved conversation'} · Profile{' '}
									{row.sourceProfileRevision}
								</p>
								<p>
									{row.permission
										? `Observe: ${row.permission.observe ? 'allowed' : 'blocked'} · Share: ${row.permission.disclose ? 'allowed' : 'blocked'} · Receive: ${row.permission.receive ? 'allowed' : 'blocked'} · Idle wake: ${row.permission.wake ? 'allowed' : 'blocked'}`
										: 'No delivery permission'}
								</p>
								<footer>
									<span>
										{row.progress.lastSequence === null
											? 'No activity checked yet'
											: `Activity checked through record ${row.progress.lastSequence}`}
									</span>
									{row.enabled && (
										<Button
											size="xs"
											variant="outline"
											disabled={disabled || !!view.subscriptionsNotice}
											onClick={() => onDisable(row.id)}
										>
											Disable
										</Button>
									)}
								</footer>
							</article>
						)
					})}
				</div>
				{view && !view.subscriptionsNotice && view.subscriptions.length === 0 && (
					<p className="quiet">No activity subscriptions yet.</p>
				)}
			</Tabs.Panel>
		</Tabs.Root>
	)
}

function SubscriptionForm({
	pal,
	state,
	disabled,
	onCreate,
}: {
	pal: Pick<PalView, 'id' | 'name'>
	state: PalCommunicationState
	disabled: boolean
	onCreate: (value: Omit<PalSubscriptionCreate, 'snapshotId'>) => void
}) {
	const sources = state.view?.sources ?? []
	const [sourceId, setSourceId] = useState(pal.id)
	const [conversationId, setConversationId] = useState('')
	const [recipientId, setRecipientId] = useState('')
	const [wake, setWake] = useState(false)
	const source = sources.find((row) => row.palId === sourceId)
	const conversation =
		source?.conversations.find((row) => row.id === conversationId) ?? source?.conversations[0]
	const recipients = sources.filter(
		(row) => row.palId !== sourceId && (sourceId === pal.id || row.palId === pal.id),
	)
	const recipient = recipients.find((row) => row.palId === recipientId) ?? recipients[0]
	return (
		<form
			className="pal-communication-form"
			onSubmit={(event) => {
				event.preventDefault()
				if (!disabled && source && conversation && recipient)
					onCreate({
						sourcePalId: source.palId,
						sourceSessionId: conversation.id,
						recipientPalId: recipient.palId,
						wake,
					})
			}}
		>
			<div className="pal-communication-selects">
				<label>
					Source Pal
					<select
						value={source?.palId ?? ''}
						disabled={disabled}
						onChange={(event) => {
							setSourceId(event.target.value)
							setConversationId('')
							setRecipientId('')
						}}
					>
						<option value="" disabled>
							Choose a Pal
						</option>
						{sources.map((row) => (
							<option key={row.palId} value={row.palId}>
								{row.name}
							</option>
						))}
					</select>
				</label>
				<label>
					Conversation
					<select
						value={conversation?.id ?? ''}
						disabled={disabled || !source?.conversations.length}
						onChange={(event) => setConversationId(event.target.value)}
					>
						<option value="" disabled>
							No owned conversations
						</option>
						{source?.conversations.map((row) => (
							<option key={row.id} value={row.id}>
								{row.title}
							</option>
						))}
					</select>
				</label>
				<label>
					Recipient
					<select
						value={recipient?.palId ?? ''}
						disabled={disabled || !recipients.length}
						onChange={(event) => setRecipientId(event.target.value)}
					>
						<option value="" disabled>
							Choose a recipient
						</option>
						{recipients.map((row) => (
							<option key={row.palId} value={row.palId}>
								{row.name}
							</option>
						))}
					</select>
				</label>
			</div>
			<footer>
				<label className="pal-communication-check">
					<input
						type="checkbox"
						checked={wake}
						disabled={disabled}
						onChange={(event) => setWake(event.target.checked)}
					/>
					<span>Allow idle wake</span>
				</label>
				<Button
					type="submit"
					size="sm"
					variant="outline"
					disabled={disabled || !conversation || !recipient}
				>
					Add subscription
				</Button>
			</footer>
		</form>
	)
}

export function PalCommunicationDialog({
	api,
	sessionId,
	pal,
	onClose,
	returnFocus,
}: {
	api: DesktopApi
	sessionId: string
	pal: PalView
	onClose: () => void
	returnFocus?: () => HTMLElement | null
}) {
	const controller = useMemo(
		() => new PalCommunicationController(api, sessionId, pal.id),
		[api, sessionId, pal.id],
	)
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	)
	useEffect(() => {
		controller.activate()
		void controller.load()
		return () => controller.dispose()
	}, [controller])
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !state.busy) onClose()
			}}
			disablePointerDismissal={state.busy}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="pal-communication-backdrop" />
				<Dialog.Viewport className="pal-communication-viewport">
					<Dialog.Popup
						className="pal-communication-popup"
						finalFocus={() => returnFocus?.() ?? true}
					>
						<header className="pal-communication-heading">
							<div>
								<Dialog.Title>{pal.name} settings</Dialog.Title>
								<Dialog.Description>Communication</Dialog.Description>
							</div>
							<Button
								size="icon-sm"
								variant="ghost-muted"
								aria-label="Refresh communication"
								disabled={state.busy || state.loading}
								onClick={() => void controller.load()}
							>
								<RefreshIcon />
							</Button>
							<Dialog.Close
								render={<Button size="icon-sm" variant="ghost-muted" disabled={state.busy} />}
								aria-label="Close Pal settings"
							>
								<XIcon />
							</Dialog.Close>
						</header>
						<PalCommunicationContent
							pal={pal}
							state={state}
							onPermission={(value) => void controller.permission(value)}
							onCreate={(value) => void controller.create(value)}
							onDisable={(id) => void controller.disable(id)}
						/>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
