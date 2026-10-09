import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
	PalInboxView,
	PalPermissionChange,
	PalSubscriptionCreate,
} from '../shared/pal-communication-protocol.js'
import type { DesktopApi, PalView } from '../shared/protocol.js'
import { LoaderCircleIcon, RefreshIcon, TrashIcon, XIcon } from './icons.js'
import {
	PalCommunicationController,
	type PalCommunicationState,
} from './pal-communication-controller.js'
import { Button } from './ui/button.js'
import { Select, SelectItem, SelectPopup, SelectTrigger } from './ui/select.js'
import './pal-communication-dialog.css'

export type PalSettingsTab = 'general' | 'inbox' | 'peers' | 'subscriptions'

/** What the General tab can do for the Pal; each action closes the dialog first. */
export interface PalSettingsActions {
	pal: Pick<PalView, 'id' | 'name' | 'paused' | 'model'>
	disabled?: boolean
	onCustomize: () => void
	onTogglePause: () => void
	onDelete?: () => void
}

/** "Oct 9, 2026, 6:53 AM" in the person's own locale; nothing when the time was never recorded. */
export function sentTime(at: number | undefined): { text: string; iso: string } | undefined {
	if (at === undefined || !Number.isFinite(at)) return undefined
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return undefined
	return {
		text: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
			date,
		),
		iso: date.toISOString(),
	}
}

/** Where a message came from, in the words the person would use. */
export function messageSource(
	message: PalInboxView,
	name: (id?: string) => string,
	conversationTitle?: (id: string) => string | undefined,
): string {
	if (message.sourceKind === 'pal') return `From ${name(message.sourcePalId)}`
	if (message.sourceKind === 'host-observation')
		return `Activity shared by ${name(message.observedPalId)}`
	if (message.sourceKind === 'operator-conversation') {
		const title = message.operatorSessionId
			? conversationTitle?.(message.operatorSessionId)?.trim()
			: undefined
		return title ? `From your conversation “${title}”` : 'From one of your conversations'
	}
	return message.provider
		? `From a connected channel (${message.provider})`
		: 'From a connected channel'
}

/** Where a message is on its way, without claiming the Pal read or answered it. */
export function messageStatus(status: PalInboxView['status'], palName: string): string {
	return status === 'pending'
		? `Waiting for ${palName} to read it`
		: status === 'claimed'
			? `${palName} is picking it up`
			: `Delivered to ${palName}’s conversation`
}

function SwitchRow({
	checked,
	disabled,
	onChange,
	children,
}: {
	checked: boolean
	disabled: boolean
	onChange: (checked: boolean) => void
	children: ReactNode
}) {
	return (
		<label className="pal-communication-check">
			<input
				type="checkbox"
				role="switch"
				aria-checked={checked}
				className="settings-switch"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>{children}</span>
		</label>
	)
}

function GeneralPanel({ settings }: { settings: PalSettingsActions }) {
	const { pal } = settings
	return (
		<div className="pal-communication-panel pal-settings-general">
			<dl className="pal-settings-facts">
				<div>
					<dt>Name</dt>
					<dd>{pal.name}</dd>
				</div>
				<div>
					<dt>Status</dt>
					<dd>
						{pal.paused ? 'Paused. It will not answer until you resume it.' : 'Ready to chat'}
					</dd>
				</div>
				<div>
					<dt>Model for new conversations</dt>
					<dd>{pal.model ? pal.model.model : 'Your default model'}</dd>
				</div>
			</dl>
			<div className="pal-settings-actions">
				<Button
					variant="outline"
					size="sm"
					disabled={settings.disabled}
					onClick={settings.onCustomize}
				>
					Change name, look or model
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={settings.disabled}
					onClick={settings.onTogglePause}
				>
					{pal.paused ? `Resume ${pal.name}` : `Pause ${pal.name}`}
				</Button>
				{settings.onDelete && (
					<Button
						variant="ghost-destructive"
						size="sm"
						disabled={settings.disabled}
						onClick={settings.onDelete}
					>
						<TrashIcon aria-hidden="true" /> Delete {pal.name}
					</Button>
				)}
			</div>
		</div>
	)
}

export function PalCommunicationContent({
	pal,
	state,
	onPermission,
	onCreate,
	onDisable,
	tab,
	settings,
	conversationTitle,
}: {
	pal: Pick<PalView, 'id' | 'name'>
	state: PalCommunicationState
	onPermission: (value: Omit<PalPermissionChange, 'snapshotId'>) => void
	onCreate: (value: Omit<PalSubscriptionCreate, 'snapshotId'>) => void
	onDisable: (id: string) => void
	tab?: PalSettingsTab
	settings?: PalSettingsActions
	conversationTitle?: (id: string) => string | undefined
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
		<Tabs.Root
			defaultValue={tab ?? (settings ? 'general' : 'inbox')}
			className="pal-communication-tabs"
		>
			<Tabs.List className="pal-communication-tab-list" aria-label="Settings sections">
				{settings && <Tabs.Tab value="general">General</Tabs.Tab>}
				<Tabs.Tab value="inbox">Messages</Tabs.Tab>
				<Tabs.Tab value="peers">Other Pals</Tabs.Tab>
				<Tabs.Tab value="subscriptions">Shared activity</Tabs.Tab>
			</Tabs.List>
			{state.error && (
				<p className="pal-communication-notice" role="alert">
					{state.error}
				</p>
			)}
			{view && !view.supported && !state.loading && (
				<output className="pal-communication-notice block">
					Messages and sharing are unavailable in this version of Namzu.
				</output>
			)}
			{state.loading && (
				<output className="pal-communication-loading">
					<LoaderCircleIcon /> Loading…
				</output>
			)}
			{state.busy && (
				<output className="pal-communication-loading">
					<LoaderCircleIcon /> Saving…
				</output>
			)}
			{settings && (
				<Tabs.Panel value="general">
					<GeneralPanel settings={settings} />
				</Tabs.Panel>
			)}
			<Tabs.Panel value="inbox" className="pal-communication-panel">
				<p className="pal-communication-help">
					Messages sent to {pal.name}. {pal.name} reads a message the next time it runs; sending one
					does not start it.
				</p>
				{view?.inboxNotice && (
					<p role="alert" className="pal-communication-notice">
						{view.inboxNotice}
					</p>
				)}
				{view && !view.inboxNotice && view.messages.length === 0 && (
					<p className="quiet">Nothing has been sent to {pal.name} yet.</p>
				)}
				<div className="pal-communication-rows">
					{view?.messages.map((message) => {
						const sent = sentTime(message.receivedAt)
						return (
							<article key={message.id} className="pal-communication-row">
								<header>
									<strong>{messageSource(message, name, conversationTitle)}</strong>
									<span className="pal-communication-badge" data-status={message.status}>
										{messageStatus(message.status, pal.name)}
									</span>
								</header>
								{message.text && (
									<blockquote className="pal-communication-message">{message.text}</blockquote>
								)}
								{sent && (
									<p className="pal-communication-sent">
										Sent at <time dateTime={sent.iso}>{sent.text}</time>
									</p>
								)}
							</article>
						)
					})}
				</div>
			</Tabs.Panel>
			<Tabs.Panel value="peers" className="pal-communication-panel">
				<p className="pal-communication-help">
					Choose which Pals {pal.name} may message. A reply needs permission in the other direction
					too. Changing these choices never starts a Pal.
				</p>
				{view?.peersNotice && (
					<p role="alert" className="pal-communication-notice">
						{view.peersNotice}
					</p>
				)}
				{view && !view.peersNotice && view.peers.length === 0 && (
					<p className="quiet">Create another Pal to let them talk to each other.</p>
				)}
				<div className="pal-communication-rows">
					{view?.peers.map((peer) => (
						<section key={peer.palId} className="pal-communication-row">
							<header>
								<strong>{peer.name}</strong>
								{peer.paused && <span className="pal-communication-badge">Paused</span>}
							</header>
							<SwitchRow
								checked={peer.outgoing.enabled}
								disabled={disabled || !!view.peersNotice}
								onChange={(enabled) =>
									onPermission({
										peerPalId: peer.palId,
										enabled,
										allowWake: enabled && peer.outgoing.allowWake,
									})
								}
							>
								Let {pal.name} message {peer.name}
							</SwitchRow>
							<SwitchRow
								checked={peer.outgoing.allowWake}
								disabled={disabled || !!view.peersNotice || !peer.outgoing.enabled}
								onChange={(allowWake) =>
									onPermission({
										peerPalId: peer.palId,
										enabled: peer.outgoing.enabled,
										allowWake,
									})
								}
							>
								Let those messages start {peer.name}
							</SwitchRow>
							<p className="pal-communication-incoming">
								{peer.incoming.enabled
									? `${peer.name} can message ${pal.name}`
									: `${peer.name} cannot message ${pal.name}`}
								{peer.incoming.enabled && peer.incoming.allowWake
									? ` and may start ${pal.name}`
									: ''}
								. Change this from {peer.name}’s own settings.
							</p>
						</section>
					))}
				</div>
			</Tabs.Panel>
			<Tabs.Panel value="subscriptions" className="pal-communication-panel">
				<p className="pal-communication-help">
					Let a second Pal follow what happens in one conversation, without seeing the messages
					themselves. Adding one lets that activity be watched, shared and received. Starting the
					other Pal is a separate choice.
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
						const allowed = (value: boolean | undefined) => (value ? 'allowed' : 'blocked')
						return (
							<article key={row.id} className="pal-communication-row">
								<header>
									<strong>
										{name(row.sourcePalId)} → {name(row.recipientPalId)}
									</strong>
									<span className="pal-communication-badge">
										{row.enabled ? (permitted ? 'Sharing' : 'Blocked') : 'Stopped'}
									</span>
								</header>
								<p>{conversation?.title ?? 'A saved conversation'}</p>
								<p>
									{row.permission
										? `Watching: ${allowed(row.permission.observe)} · Sharing: ${allowed(row.permission.disclose)} · Receiving: ${allowed(row.permission.receive)} · Starting the other Pal: ${allowed(row.permission.wake)}`
										: 'No permission has been given.'}
								</p>
								<footer>
									<span>
										{row.progress.lastSequence === null
											? 'Nothing shared yet'
											: `Shared up to activity ${row.progress.lastSequence}`}
									</span>
									{row.enabled && (
										<Button
											size="xs"
											variant="outline"
											disabled={disabled || !!view.subscriptionsNotice}
											onClick={() => onDisable(row.id)}
										>
											Stop sharing
										</Button>
									)}
								</footer>
							</article>
						)
					})}
				</div>
				{view && !view.subscriptionsNotice && view.subscriptions.length === 0 && (
					<p className="quiet">Nothing is being shared yet.</p>
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
				<div className="pal-communication-field">
					<span id={`${pal.id}-share-from`}>Follow activity from</span>
					<Select
						value={source?.palId ?? ''}
						disabled={disabled}
						onValueChange={(value) => {
							setSourceId(String(value))
							setConversationId('')
							setRecipientId('')
						}}
					>
						<SelectTrigger aria-labelledby={`${pal.id}-share-from`} size="sm">
							{source?.name ?? 'Choose a Pal'}
						</SelectTrigger>
						<SelectPopup>
							{sources.map((row) => (
								<SelectItem key={row.palId} value={row.palId}>
									{row.name}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				</div>
				<div className="pal-communication-field">
					<span id={`${pal.id}-share-conversation`}>Conversation</span>
					<Select
						value={conversation?.id ?? ''}
						disabled={disabled || !source?.conversations.length}
						onValueChange={(value) => setConversationId(String(value))}
					>
						<SelectTrigger aria-labelledby={`${pal.id}-share-conversation`} size="sm">
							{conversation?.title ?? 'No conversations yet'}
						</SelectTrigger>
						<SelectPopup>
							{source?.conversations.map((row) => (
								<SelectItem key={row.id} value={row.id}>
									{row.title}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				</div>
				<div className="pal-communication-field">
					<span id={`${pal.id}-share-with`}>Share it with</span>
					<Select
						value={recipient?.palId ?? ''}
						disabled={disabled || !recipients.length}
						onValueChange={(value) => setRecipientId(String(value))}
					>
						<SelectTrigger aria-labelledby={`${pal.id}-share-with`} size="sm">
							{recipient?.name ?? 'Choose a Pal'}
						</SelectTrigger>
						<SelectPopup>
							{recipients.map((row) => (
								<SelectItem key={row.palId} value={row.palId}>
									{row.name}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				</div>
			</div>
			<footer>
				<SwitchRow checked={wake} disabled={disabled} onChange={setWake}>
					Let this activity start the other Pal
				</SwitchRow>
				<Button
					type="submit"
					size="sm"
					variant="outline"
					disabled={disabled || !conversation || !recipient}
				>
					Start sharing
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
	tab,
	settings,
	conversationTitle,
}: {
	api: DesktopApi
	sessionId: string
	pal: PalView
	onClose: () => void
	returnFocus?: () => HTMLElement | null
	tab?: PalSettingsTab
	settings?: PalSettingsActions
	conversationTitle?: (id: string) => string | undefined
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
								<Dialog.Description>
									Messages, other Pals and shared activity for {pal.name}.
								</Dialog.Description>
							</div>
							<Button
								size="icon-sm"
								variant="ghost-muted"
								aria-label="Refresh"
								title="Refresh"
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
							tab={tab}
							settings={settings}
							conversationTitle={conversationTitle}
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
