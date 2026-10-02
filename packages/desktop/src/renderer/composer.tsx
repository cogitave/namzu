import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type {
	AttachmentView,
	ComposerModelSettings,
	DesktopSendOptions,
	PermissionView,
	ProviderView,
	QueuedMessageView,
} from '../shared/protocol.js'
import { AttachmentList } from './attachment-list.js'
import { ComposerApproval } from './composer-approval.js'
import { ComposerControl } from './composer-control.js'
import {
	type ComposerPlugin,
	type ComposerPluginInventory,
	ComposerPlugins,
} from './composer-plugins.js'
import { ComposerSettings } from './composer-settings.js'
import { ComposerSurface } from './composer-surface.js'
import {
	ArrowUpIcon,
	ChevronDownIcon,
	FileDiffIcon,
	FolderIcon,
	ListPlusIcon,
	ListTodoIcon,
	LoaderCircleIcon,
	MoreHorizontalIcon,
	PaperclipIcon,
	SearchIcon,
	SquareIcon,
} from './icons.js'
import { type ModelChoice, ModelPicker } from './model-picker.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Textarea } from './ui/textarea.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'

export function Composer({
	inputRef,
	draft,
	onDraftChange,
	providers,
	connected,
	modelSelectionReady = connected,
	providersLoading = false,
	choice,
	onChoiceChange,
	running,
	sending,
	queued,
	queuedItems,
	editingQueued,
	onSend,
	onStop,
	onEditQueued,
	onRemoveQueued,
	projectName,
	projectId,
	sessionId,
	projectPath,
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
}: {
	inputRef: RefObject<HTMLTextAreaElement | null>
	draft: string
	onDraftChange: (draft: string) => void
	providers: ProviderView
	connected: boolean
	/** Catalogue access does not require a Pal's execution computer. */
	modelSelectionReady?: boolean
	providersLoading?: boolean
	choice: ModelChoice
	onChoiceChange: (choice: ModelChoice) => void
	running: boolean
	sending: boolean
	queued: string[]
	queuedItems: QueuedMessageView[]
	editingQueued: boolean
	onSend: () => void
	onStop: () => void
	onEditQueued: (itemId?: string) => void
	onRemoveQueued: (itemId: string) => void
	projectName: string
	projectId: string
	sessionId?: string
	projectPath: string
	onOpenProject: () => void
	empty: boolean
	permissions: PermissionView[]
	onApproval: (permission: PermissionView, approved: boolean) => void
	attachments: AttachmentView[]
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
	const [dragging, setDragging] = useState(false)
	const dragDepth = useRef(0)
	const importDisabled = sending || attachmentsBusy || editingQueued || !connected
	const permissionLabel = {
		prompt: 'Ask first',
		'accept-edits': 'Allow edits',
		auto: 'Allow tools',
		strict: 'Preapproved',
		plan: 'Plan',
	}[settings.permissionMode ?? 'prompt']
	const overlay = useRef<HTMLDivElement>(null)
	const previous = useRef<{ top: number; empty: boolean } | null>(null)
	useLayoutEffect(() => {
		const node = overlay.current
		const stage = node?.parentElement
		if (!node || !stage) return
		const update = () =>
			stage.style.setProperty(
				'--composer-height',
				`${empty ? 0 : node.getBoundingClientRect().height}px`,
			)
		const stack = node.querySelector<HTMLElement>('[data-chat-composer-stack]')
		const nextTop = stack?.getBoundingClientRect().top
		let transition: Animation | undefined
		if (
			stack &&
			nextTop !== undefined &&
			previous.current &&
			previous.current.empty !== empty &&
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
		if (nextTop !== undefined) previous.current = { top: nextTop, empty }
		const observer = new ResizeObserver(update)
		observer.observe(node)
		update()
		return () => {
			observer.disconnect()
			transition?.cancel()
		}
	}, [empty])
	return (
		<div
			ref={overlay}
			data-chat-composer-overlay
			className={
				empty
					? 'composer-wrap pointer-events-none absolute inset-0 z-20 flex items-center'
					: 'composer-wrap pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2'
			}
		>
			<div className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
				<div
					data-chat-composer-stack
					className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)"
				>
					{empty && (
						<div className="absolute inset-x-0 bottom-full pb-8">
							<h1 className="text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
								What would you like to work on?
							</h1>
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
									{queued.length} queued
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
										These messages start in order after the current turn finishes.
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
														disabled={draft.length > 0 || editingQueued}
														title={draft.length > 0 ? 'Send or clear your draft first' : undefined}
														onClick={() => onEditQueued(item.id)}
													>
														Edit
													</Button>
													<Button
														variant="ghost-muted"
														size="xs"
														aria-label={`Remove queued message ${index + 1}`}
														onClick={() => onRemoveQueued(item.id)}
													>
														Remove
													</Button>
												</div>
											</li>
										))}
									</ol>
									{draft.length > 0 && (
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
								disabled={draft.length > 0 || editingQueued}
								title={draft.length > 0 ? 'Send or clear your draft first' : undefined}
								onClick={() => onEditQueued()}
							>
								Edit latest
							</Button>
						</div>
					)}
					<ComposerSurface.Shell
						contextStrip
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
						{permissions[0] && (
							<ComposerApproval
								key={permissions[0].id}
								permission={permissions[0]}
								count={permissions.length}
								onRespond={onApproval}
							/>
						)}
						<ComposerSurface.Host>
							<ComposerSurface.Main>
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
												disabled={importDisabled}
												onRemove={onRemoveAttachment}
											/>
										</div>
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
										disabled={editingQueued}
										placeholder="Ask Namzu anything"
										onChange={(event) => onDraftChange(event.target.value)}
										onPaste={(event) => {
											const files = Array.from(event.clipboardData.files)
											if (files.length === 0) return
											event.preventDefault()
											if (!importDisabled) onAddFiles(files)
										}}
										onKeyDown={(event) => {
											if (
												event.key === 'Enter' &&
												!event.shiftKey &&
												!event.nativeEvent.isComposing
											) {
												event.preventDefault()
												onSend()
											}
										}}
									/>
								</div>
								<div
									data-chat-composer-footer
									className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
								>
									<div className="flex min-w-0 flex-1 items-center gap-1">
										<div className="min-w-0 max-w-full">
											<ModelPicker
												projectId={projectId}
												sessionId={sessionId}
												providers={providers}
												choice={choice}
												onChange={onChoiceChange}
												disabled={running || sending || !modelSelectionReady}
											/>
										</div>
										<Popover>
											<PopoverTrigger
												render={<ComposerControl size="xs" />}
												aria-label="Model and tool settings"
												disabled={sending || !connected}
											>
												<MoreHorizontalIcon className="size-4" />
												{settings.effort && (
													<span>
														{settings.effort === 'xhigh'
															? 'Extra high'
															: settings.effort[0]?.toUpperCase() + settings.effort.slice(1)}
													</span>
												)}
											</PopoverTrigger>
											<PopoverPopup
												side="top"
												align="start"
												width="md"
												aria-label="Model and tool settings"
											>
												<h2 className="mb-3 text-sm font-medium">Message settings</h2>
												<div className="flex flex-wrap items-center gap-2">
													<ComposerSettings
														effortLevels={capabilities?.effortLevels}
														effortDefault={capabilities?.effortDefault}
														effort={settings.effort}
														permissionMode={settings.permissionMode ?? 'prompt'}
														disabled={sending}
														onEffortChange={(effort) => onSettingsChange({ ...settings, effort })}
														onPermissionModeChange={(permissionMode) =>
															onSettingsChange({ ...settings, permissionMode })
														}
													/>
												</div>
												<p className="mt-3 text-xs text-muted-foreground">
													These choices apply to this message.{' '}
													{running && 'Running work keeps its current settings.'}
												</p>
												{capabilities?.notice && (
													<p className="mt-2 text-xs text-muted-foreground">
														{capabilities.notice}
													</p>
												)}
											</PopoverPopup>
										</Popover>
									</div>
									<div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
										<Tooltip>
											<TooltipTrigger
												render={<ComposerControl />}
												aria-label="Attach files"
												disabled={importDisabled}
												onClick={onAttach}
											>
												<PaperclipIcon className="size-4" />
											</TooltipTrigger>
											<TooltipPopup>Attach images or text files</TooltipPopup>
										</Tooltip>
										{running && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-black/8 active:shadow-none"
															aria-label="Stop turn"
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
																sending ? 'Sending' : running ? 'Queue message' : 'Send message'
															}
															aria-busy={sending}
															disabled={
																(!draft.trim() && attachments.length === 0) ||
																!choice.provider ||
																sending ||
																attachmentsBusy ||
																!connected
															}
															onClick={onSend}
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
															? 'Queue for the next turn'
															: 'Send message · Enter'}
												</TooltipPopup>
											</Tooltip>
										)}
									</div>
								</div>
							</ComposerSurface.Main>
						</ComposerSurface.Host>
						<ComposerSurface.ContextStrip>
							<ComposerControl
								size="xs"
								onClick={onOpenProject}
								aria-label="Choose project folder"
								className="min-w-0 shrink flex-1 justify-start overflow-hidden"
								title={projectPath}
							>
								<FolderIcon className="size-3.5" />
								<span className="truncate">{projectName}</span>
							</ComposerControl>
							<ComposerControl size="xs" onClick={onAttach} disabled={importDisabled}>
								<PaperclipIcon className="size-3.5" />
								<span>Files</span>
							</ComposerControl>
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
							<span
								data-composer-permission={settings.permissionMode ?? 'prompt'}
								className="ml-auto shrink-0 pe-1 text-xs text-muted-foreground/70"
							>
								{permissionLabel}
							</span>
						</ComposerSurface.ContextStrip>
					</ComposerSurface.Shell>
					{empty &&
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
