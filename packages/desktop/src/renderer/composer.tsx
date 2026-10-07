import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type {
	AttachmentView,
	ComposerModelSettings,
	DesktopSendOptions,
	HarnessView,
	PermissionResponse,
	PermissionView,
	ProjectView,
	ProviderView,
	QueuedMessageView,
} from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { ComposerApproval } from './composer-approval.js'
import { PARKED_QUEUE_COPY, UNSUPPORTED_ATTACHMENTS_HINT, decidePaste } from './composer-input.js'
import {
	type ComposerPlugin,
	type ComposerPluginInventory,
	ComposerPlugins,
} from './composer-plugins.js'
import { ComposerProjectPicker } from './composer-project-picker.js'
import {
	type ComposerPermissionMode,
	ComposerPermissions,
	ComposerSettings,
} from './composer-settings.js'
import { ComposerSurface } from './composer-surface.js'
import { HarnessPicker } from './harness-picker.js'
import {
	ArrowUpIcon,
	ChevronDownIcon,
	FileDiffIcon,
	ListPlusIcon,
	ListTodoIcon,
	LoaderCircleIcon,
	MonitorIcon,
	PaperclipIcon,
	PlusIcon,
	SearchIcon,
	SquareIcon,
} from './icons.js'
import { type ModelChoice, ModelPicker } from './model-picker.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Textarea } from './ui/textarea.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './composer.css'

export function Composer({
	draftDisabled = false,
	inputRef,
	variant = 'default',
	draft,
	onDraftChange,
	providers,
	connected,
	toolsAvailable = connected,
	pluginsSupported = true,
	modelSelectionReady = connected,
	providersLoading = false,
	choice,
	onChoiceChange,
	running,
	liveInputSupported = false,
	liveInputs = [],
	sending,
	queued,
	queuedItems,
	queueParked = false,
	editingQueued,
	onSend,
	onQueue,
	onStop,
	onEditQueued,
	onRemoveQueued,
	projectName,
	projectId,
	sessionId,
	projectPath,
	projects,
	onSelectProject,
	computerLabel = 'This computer',
	harnessView,
	harnessBusy = false,
	onHarnessChange,
	attachmentsSupported = true,
	reviewModes,
	permissionEngine,
	permissionScope,
	onLeaveProject,
	onOpenProject,
	empty,
	permissions,
	onApproval,
	attachments,
	attachmentsBusy,
	onAttach,
	onAddFiles,
	onRemoveAttachment,
	settings,
	capabilities,
	onSettingsChange,
	plugins,
	pluginsLoading,
	onOpenPlugins,
	onSetPluginEnabled,
	speechControl,
}: {
	speechControl?: ReactNode
	inputRef: RefObject<HTMLTextAreaElement | null>
	variant?: 'default' | 'pal'
	draft: string
	onDraftChange: (draft: string) => void
	providers: ProviderView
	connected: boolean
	/** Chat admission does not imply that guest tools are available. */
	toolsAvailable?: boolean
	pluginsSupported?: boolean
	/** Catalogue access does not require a Pal's execution computer. */
	modelSelectionReady?: boolean
	providersLoading?: boolean
	choice: ModelChoice
	onChoiceChange: (choice: ModelChoice) => void
	running: boolean
	liveInputSupported?: boolean
	liveInputs?: readonly {
		id: string
		prompt: string
		status: 'pending' | 'delivered' | 'unknown'
	}[]
	sending: boolean
	queued: string[]
	queuedItems: QueuedMessageView[]
	/** Queued messages wait because the last turn stopped or failed. */
	queueParked?: boolean
	editingQueued: boolean
	onSend: () => void
	onQueue?: () => void
	onStop: () => void
	onEditQueued: (itemId?: string) => void
	onRemoveQueued: (itemId: string) => void
	projectName: string
	projectId: string
	sessionId?: string
	projectPath: string
	projects?: readonly ProjectView[]
	onSelectProject?: (project: ProjectView) => void
	computerLabel?: string
	harnessView?: HarnessView
	harnessBusy?: boolean
	onHarnessChange?: (engine: HarnessView['selected']) => void
	attachmentsSupported?: boolean
	reviewModes?: readonly ComposerPermissionMode[]
	permissionEngine?: HarnessView['selected']
	permissionScope?: string
	onLeaveProject?: () => void
	onOpenProject: () => void
	empty: boolean
	permissions: PermissionView[]
	onApproval: (permission: PermissionView, response: PermissionResponse) => unknown
	attachments: AttachmentView[]
	draftDisabled?: boolean
	attachmentsBusy: boolean
	onAttach: () => void
	onAddFiles: (files: File[]) => void
	onRemoveAttachment: (id: string) => void
	settings: DesktopSendOptions
	capabilities: ComposerModelSettings | null
	onSettingsChange: (settings: DesktopSendOptions) => void
	plugins?: ComposerPluginInventory
	pluginsLoading: boolean
	onOpenPlugins: () => void
	onSetPluginEnabled: (plugin: ComposerPlugin, enabled: boolean) => Promise<void>
}) {
	const compact = variant === 'pal'
	const centered = empty && !compact
	const approvalDisabled = !connected || !toolsAvailable || draftDisabled || harnessBusy
	const [dragging, setDragging] = useState(false)
	const dragDepth = useRef(0)
	const importDisabled =
		sending ||
		attachmentsBusy ||
		editingQueued ||
		draftDisabled ||
		!connected ||
		!attachmentsSupported
	// Removal stays possible on engines that cannot take attachments, so a draft is never stranded.
	const removeDisabled = sending || attachmentsBusy || editingQueued || draftDisabled || !connected
	const attachmentsStranded = attachments.length > 0 && !attachmentsSupported
	const hasDraft = draft.length > 0 || attachments.length > 0
	const [pasteNotice, setPasteNotice] = useState<string>()
	const modelControl = (
		<ModelPicker
			projectId={projectId}
			sessionId={sessionId}
			catalogueHarnessScope={permissionEngine ?? harnessView?.selected ?? 'namzu'}
			providers={providers}
			choice={choice}
			onChange={onChoiceChange}
			catalogueEnabled={modelSelectionReady && !harnessBusy}
			disabled={running || sending || !modelSelectionReady || harnessBusy}
			settings={capabilities}
			effort={settings.effort}
			onEffortChange={(effort) => onSettingsChange({ ...settings, effort })}
		/>
	)
	const settingsControl = (
		<ComposerSettings
			engine={permissionEngine ?? harnessView?.selected}
			permissionScope={permissionScope}
			reviewModes={reviewModes}
			permissionMode={settings.permissionMode ?? 'prompt'}
			disabled={sending || !connected || !toolsAvailable}
			onPermissionModeChange={(permissionMode) => onSettingsChange({ ...settings, permissionMode })}
		/>
	)
	const pluginControl = (
		<ComposerPlugins
			scope={JSON.stringify([projectId, sessionId, choice.provider, choice.model])}
			view={
				plugins && {
					...plugins,
					canChange: plugins.canChange && !running && permissions.length === 0,
				}
			}
			loading={pluginsLoading}
			disabled={sending || !connected}
			onOpen={onOpenPlugins}
			onSetEnabled={onSetPluginEnabled}
		/>
	)
	const plusControl = (
		<Popover>
			<PopoverTrigger
				render={<Button variant="ghost-muted" size="icon-sm" />}
				className={compact ? 'pal-composer-add' : 'composer-add'}
				aria-label="Attachments and message settings"
				disabled={editingQueued}
			>
				<PlusIcon />
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="start"
				width="md"
				padding="compact"
				aria-label="Attachments and message settings"
				className="pal-composer-tools"
			>
				<Button
					variant="ghost"
					size="sm"
					className="pal-composer-attach"
					aria-label="Attach files"
					disabled={importDisabled}
					onClick={onAttach}
				>
					<PaperclipIcon /> Attach images or files
				</Button>
				{compact && (
					<div className="pal-composer-tool-section">
						<h2>Model</h2>
						{modelControl}
					</div>
				)}
				{compact && (
					<div className="pal-composer-tool-section">
						<h2>Message settings</h2>
						<div className="flex flex-wrap gap-2">{settingsControl}</div>
						<p className="mt-2 text-xs text-muted-foreground">
							These choices apply to the next message.{' '}
							{running && 'Running work keeps its current settings.'}
						</p>
					</div>
				)}
				{pluginsSupported && <div className="pal-composer-tool-section">{pluginControl}</div>}
			</PopoverPopup>
		</Popover>
	)
	// A settled turn has nothing in flight; only unconfirmed receipts are worth showing.
	const shownLiveInputs = running
		? liveInputs
		: liveInputs.filter((item) => item.status !== 'delivered')
	const overlay = useRef<HTMLDivElement>(null)
	const previous = useRef<{ top: number; empty: boolean } | null>(null)
	useLayoutEffect(() => {
		const node = overlay.current
		const stage = node?.parentElement
		if (!node || !stage) return
		const update = () => {
			const height = `${centered ? 0 : node.getBoundingClientRect().height}px`
			if (stage.style.getPropertyValue('--composer-height') !== height)
				stage.style.setProperty('--composer-height', height)
		}
		let resizeFrame: number | undefined
		const scheduleResize = () => {
			if (resizeFrame !== undefined) return
			// Transcript padding also uses this height. Write after resize delivery
			// so mounting an approval banner cannot dirty a sibling observer mid-loop.
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = undefined
				update()
			})
		}
		const stack = node.querySelector<HTMLElement>('[data-chat-composer-stack]')
		const nextTop = stack?.getBoundingClientRect().top
		let transition: Animation | undefined
		if (
			stack &&
			nextTop !== undefined &&
			previous.current &&
			previous.current.empty !== centered &&
			!window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			transition = stack.animate(
				[
					{ transform: `translateY(${previous.current.top - nextTop}px)` },
					{ transform: 'translateY(0px)' },
				],
				{ duration: 220, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
			)
			transition.id = 'namzu-composer-transition'
		}
		if (nextTop !== undefined) previous.current = { top: nextTop, empty: centered }
		const observer = new ResizeObserver(scheduleResize)
		observer.observe(node)
		update()
		return () => {
			observer.disconnect()
			if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
			transition?.cancel()
		}
	}, [centered])
	return (
		<div
			ref={overlay}
			data-chat-composer-overlay
			data-composer-variant={variant}
			className={
				centered
					? 'composer-wrap pointer-events-none absolute inset-0 z-20 flex items-center'
					: 'composer-wrap pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2'
			}
		>
			<div className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
				<div
					data-chat-composer-stack
					className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)"
				>
					{empty && !compact && (
						<div className="absolute inset-x-0 bottom-full pb-8">
							<h1 className="text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
								What would you like to work on?
							</h1>
						</div>
					)}
					{shownLiveInputs.length > 0 && (
						<div className="queue px-3 pb-2 text-xs text-muted-foreground" aria-live="polite">
							{[
								shownLiveInputs.some((item) => item.status === 'unknown')
									? 'Delivery unconfirmed'
									: undefined,
								shownLiveInputs.filter((item) => item.status === 'pending').length
									? `${shownLiveInputs.filter((item) => item.status === 'pending').length} sending to this turn`
									: undefined,
								shownLiveInputs.filter((item) => item.status === 'delivered').length
									? `${shownLiveInputs.filter((item) => item.status === 'delivered').length} delivered`
									: undefined,
							]
								.filter(Boolean)
								.join(' · ')}
						</div>
					)}
					{queued.length > 0 && (
						<div className="queue flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
							<ListPlusIcon className="size-3.5" />
							<Popover>
								<PopoverTrigger
									render={<Button variant="ghost-muted" size="xs" />}
									aria-label="Show queued messages"
								>
									{queued.length} {queueParked ? 'paused' : 'queued'}
									<ChevronDownIcon className="size-3" />
								</PopoverTrigger>
								<PopoverPopup
									aria-label="Queued messages"
									align="start"
									side="top"
									width="lg"
									padding="compact"
									className="max-h-[min(24rem,var(--available-height))]"
								>
									<h2 className="text-sm font-medium">Next turns</h2>
									<p className="mt-1 text-xs text-muted-foreground">
										{queueParked
											? PARKED_QUEUE_COPY
											: 'These messages start in order after the current turn finishes.'}
									</p>
									<ol className="mt-3 space-y-2">
										{queuedItems.map((item, index) => (
											<li
												key={item.id}
												data-queued-message-id={item.id}
												className="rounded-2xl border border-dashed border-border p-3"
											>
												<p className="whitespace-pre-wrap wrap-anywhere text-sm text-message-foreground">
													{item.prompt}
												</p>
												{item.attachments && (
													<div className="mt-2">
														<AttachmentList attachments={item.attachments} />
													</div>
												)}
												<div className="mt-2 flex items-center justify-end gap-1">
													<Button
														variant="ghost-muted"
														size="xs"
														aria-label={`Edit queued message ${index + 1}`}
														disabled={draftDisabled || hasDraft || editingQueued}
														title={hasDraft ? 'Send or clear your draft first' : undefined}
														onClick={() => onEditQueued(item.id)}
													>
														Edit
													</Button>
													<Button
														variant="ghost-muted"
														size="xs"
														aria-label={`Remove queued message ${index + 1}`}
														disabled={draftDisabled}
														onClick={() => onRemoveQueued(item.id)}
													>
														Remove
													</Button>
												</div>
											</li>
										))}
									</ol>
									{hasDraft && (
										<p className="mt-2 text-xs text-muted-foreground">
											Send or clear your draft before editing a queued message.
										</p>
									)}
								</PopoverPopup>
							</Popover>
							<span className="min-w-0 flex-1 truncate">
								{queued[0]?.slice(0, 100) ||
									queuedItems[0]?.attachments?.map((file) => file.name).join(', ')}
							</span>
							<Button
								variant="ghost-muted"
								size="xs"
								disabled={draftDisabled || hasDraft || editingQueued}
								title={hasDraft ? 'Send or clear your draft first' : undefined}
								onClick={() => onEditQueued()}
							>
								Edit latest
							</Button>
						</div>
					)}
					<ComposerSurface.Shell
						contextStrip={!compact}
						contextPlacement="top"
						className={compact ? 'pal-composer-shell' : 'normal-composer-shell'}
						onDragEnter={(event) => {
							if (!event.dataTransfer.types.includes('Files')) return
							event.preventDefault()
							dragDepth.current += 1
							if (!importDisabled) setDragging(true)
						}}
						onDragOver={(event) => {
							if (!event.dataTransfer.types.includes('Files')) return
							event.preventDefault()
							event.dataTransfer.dropEffect = importDisabled ? 'none' : 'copy'
						}}
						onDragLeave={() => {
							dragDepth.current = Math.max(0, dragDepth.current - 1)
							if (!dragDepth.current) setDragging(false)
						}}
						onDrop={(event) => {
							if (!event.dataTransfer.types.includes('Files')) return
							event.preventDefault()
							dragDepth.current = 0
							setDragging(false)
							if (!importDisabled) onAddFiles(Array.from(event.dataTransfer.files))
						}}
					>
						{!compact && (
							<ComposerSurface.ContextStrip placement="top">
								<ComposerProjectPicker
									projectId={projectId}
									projectName={projectName}
									projectPath={projectPath}
									projects={projects}
									onLeaveProject={onLeaveProject}
									onSelectProject={onSelectProject}
									onOpenProject={onOpenProject}
								/>
								<span className="composer-computer-label" title={computerLabel}>
									<MonitorIcon aria-hidden="true" />
									<span>{computerLabel}</span>
								</span>
								<HarnessPicker
									view={harnessView}
									selectedEngine={permissionEngine}
									busy={harnessBusy}
									disabled={!connected || running || sending}
									onSelect={onHarnessChange ?? (() => {})}
								/>
							</ComposerSurface.ContextStrip>
						)}
						{permissions[0] && (
							<fieldset
								className="m-0 min-w-0 border-0 p-0"
								disabled={approvalDisabled}
								aria-label="Action approval controls"
							>
								<ComposerApproval
									key={permissions[0].id}
									permission={permissions[0]}
									count={permissions.length}
									onRespond={(permission, response) =>
										approvalDisabled ? false : onApproval(permission, response)
									}
								/>
							</fieldset>
						)}
						<ComposerSurface.Host>
							<ComposerSurface.Main>
								{compact && plusControl}
								<div
									data-chat-composer-body
									data-resting={false}
									data-approval={permissions.length > 0}
									className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4"
								>
									{attachments.length > 0 && (
										<div className="pb-3">
											<AttachmentList
												attachments={attachments}
												disabled={removeDisabled}
												fallbackFocus={inputRef}
												onRemove={onRemoveAttachment}
											/>
										</div>
									)}
									{attachmentsStranded && (
										<output className="block pb-2 text-xs text-muted-foreground">
											{UNSUPPORTED_ATTACHMENTS_HINT}
										</output>
									)}
									{pasteNotice && (
										<output className="block pb-2 text-xs text-muted-foreground">
											{pasteNotice}
										</output>
									)}
									{attachmentsBusy && (
										<output className="pb-2 text-xs text-muted-foreground">Adding files…</output>
									)}
									{dragging && (
										<div className="composer-drop-target" aria-hidden="true">
											<PaperclipIcon />
											<span>Drop files to attach</span>
										</div>
									)}
									<Textarea
										unstyled
										className="composer-input"
										aria-label="Message Namzu"
										ref={inputRef}
										value={draft}
										maxLength={50000}
										disabled={editingQueued || draftDisabled}
										placeholder={compact ? 'Send a message' : 'Ask Namzu anything'}
										onChange={(event) => {
											setPasteNotice(undefined)
											onDraftChange(event.target.value)
										}}
										onPaste={(event) => {
											const files = Array.from(event.clipboardData.files)
											const decision = decidePaste({
												text: event.clipboardData.getData('text/plain'),
												fileCount: files.length,
												importDisabled,
												attachmentsSupported,
											})
											if (decision.action === 'default') {
												setPasteNotice(undefined)
												return
											}
											event.preventDefault()
											if (decision.action === 'import') {
												setPasteNotice(undefined)
												onAddFiles(files)
											} else setPasteNotice(decision.notice)
										}}
										onKeyDown={(event) => {
											if (
												event.key === 'Enter' &&
												!event.shiftKey &&
												!event.nativeEvent.isComposing
											) {
												event.preventDefault()
												if (!attachmentsStranded) onSend()
											}
										}}
									/>
								</div>
								<div
									data-chat-composer-footer
									className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
								>
									{!compact && (
										<div className="composer-footer-options">
											{plusControl}
											<ComposerPermissions
												engine={permissionEngine ?? harnessView?.selected}
												permissionScope={permissionScope}
												permissionMode={settings.permissionMode ?? 'prompt'}
												reviewModes={reviewModes}
												disabled={sending || !connected}
												onChange={(permissionMode) =>
													onSettingsChange({ ...settings, permissionMode })
												}
											/>
										</div>
									)}
									<div className="pal-composer-send-actions flex shrink-0 flex-nowrap items-center justify-end gap-2">
										{running && liveInputSupported && onQueue && (
											<Button
												variant="ghost-muted"
												size="xs"
												aria-label="Queue for next turn"
												disabled={
													sending ||
													draftDisabled ||
													attachmentsStranded ||
													(!draft.trim() && attachments.length === 0)
												}
												onClick={onQueue}
											>
												Queue
											</Button>
										)}
										{!compact && <div className="composer-selected-model">{modelControl}</div>}
										{speechControl}
										{running && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-black/8 active:shadow-none"
															aria-label="Stop turn"
															disabled={draftDisabled}
															onClick={onStop}
														/>
													}
												>
													<SquareIcon className="size-3 fill-current" />
												</TooltipTrigger>
												<TooltipPopup>Stop · Esc</TooltipPopup>
											</Tooltip>
										)}
										{(!running || draft.trim() || attachments.length > 0) && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover"
															aria-label={
																sending
																	? 'Sending'
																	: running && liveInputSupported && attachments.length === 0
																		? 'Send to current turn'
																		: running
																			? 'Queue message'
																			: 'Send message'
															}
															aria-busy={sending}
															disabled={
																(!draft.trim() && attachments.length === 0) ||
																!choice.provider ||
																sending ||
																attachmentsBusy ||
																attachmentsStranded ||
																!connected
															}
															onClick={(event) => {
																// Sending disables the button, which would drop focus to the page.
																const hadFocus = document.activeElement === event.currentTarget
																onSend()
																if (hadFocus) requestAnimationFrame(() => inputRef.current?.focus())
															}}
														/>
													}
												>
													{sending ? (
														<LoaderCircleIcon
															className="composer-send-spinner size-3.5"
															aria-hidden="true"
														/>
													) : (
														<ArrowUpIcon className="size-3.5" strokeWidth={1.8} />
													)}
												</TooltipTrigger>
												<TooltipPopup>
													{sending
														? 'Sending'
														: running
															? liveInputSupported && attachments.length === 0
																? 'Send text to this running turn with its current model and review settings'
																: 'Queue for the next turn'
															: 'Send message · Enter'}
												</TooltipPopup>
											</Tooltip>
										)}
									</div>
								</div>
							</ComposerSurface.Main>
						</ComposerSurface.Host>
					</ComposerSurface.Shell>
					{empty &&
						!compact &&
						draft.length === 0 &&
						attachments.length === 0 &&
						providers.available.length > 0 && (
							<div className="starter-actions" aria-label="Ideas to get started">
								{[
									{ label: 'Explore this project', Icon: SearchIcon },
									{ label: 'Review a change', Icon: FileDiffIcon },
									{ label: 'Plan a task', Icon: ListTodoIcon },
								].map(({ label, Icon }) => (
									<button
										type="button"
										key={label}
										onClick={() => {
											onDraftChange(`${label}. `)
											inputRef.current?.focus()
										}}
									>
										<Icon aria-hidden="true" />
										<span>{label}</span>
									</button>
								))}
							</div>
						)}
					{!providersLoading && providers.available.length === 0 && (
						<p className="notice">
							Connect a provider in the Namzu terminal app, then reconnect this project.
						</p>
					)}
					<div aria-hidden className="h-4 sm:h-5" />
				</div>
			</div>
		</div>
	)
}
