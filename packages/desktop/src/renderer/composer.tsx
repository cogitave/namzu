import type { ReviewMode } from '@namzu/sdk'
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
} from '../shared/protocol.js'
import type { ProjectPrView } from '../shared/protocol.js'
import { usableProviders } from '../shared/provider-connections.js'
import { AttachmentList } from './attachment-list.js'
import { ComposerApproval } from './composer-approval.js'
import {
	type HistoryWalk,
	activeWalk,
	caretAfterStep,
	historyCounter,
	stepHistory,
} from './composer-history.js'
import {
	DRAFT_LIMIT,
	UNSUPPORTED_ATTACHMENTS_HINT,
	composerPlaceholder,
	decidePaste,
	pasteOverflow,
	pasteOverflowNotice,
	stopTooltip,
} from './composer-input.js'
import { decideComposerKey, isComposing } from './composer-keys.js'
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
import { ComposerTray, type ComposerTrayActions } from './composer-tray.js'
import { automaticChoiceNote } from './first-open-note.js'
import { type EngineSurfaceControl, engineLabel } from './harness-picker.js'
import { HomeHeadingName } from './home-heading-name.js'
import {
	ArrowUpIcon,
	FileDiffIcon,
	ListPlusIcon,
	ListTodoIcon,
	LoaderCircleIcon,
	PaperclipIcon,
	PlusIcon,
	SearchIcon,
	SquareIcon,
	TerminalIcon,
} from './icons.js'
import { cn } from './lib/utils.js'
import { type ModelChoice, ModelPicker } from './model-picker.js'
import type { PendingMessages } from './pending-messages.js'
import { usePresence } from './presence.js'
import { DEFAULT_HOME_HEADING } from './project-home.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Textarea } from './ui/textarea.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './composer.css'
import type { ThreadUsage } from '../shared/projection.js'
import { ContextReadout, ContextRing } from './context-ring-view.js'

/**
 * The picker's modes are the ones this window offers. The kernel's old `auto`,
 * saved by earlier versions as Full access, is shown as Full access (`bypass`).
 */
function composerPermissionMode(mode: ReviewMode | undefined): ComposerPermissionMode {
	return mode === 'auto' ? 'bypass' : (mode ?? 'prompt')
}

const PROVIDER_EMPTY_HELP =
	'Namzu needs a model provider to answer. Paste an API key, or sign in with Claude Code or Codex and Namzu will find that sign-in.'

/** The review state in plain words, for the pull request chip's tooltip and name. */
const REVIEW_WORDS: Record<ProjectPrView['review'], string> = {
	approved: 'approved',
	changes: 'changes requested',
	pending: 'waiting for review',
	merged: 'merged',
	draft: 'draft',
}

const DEFAULT_STARTERS = ['Explore this project', 'Review a change', 'Plan a task'] as const

export function Composer({
	draftDisabled = false,
	blockedNotice,
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
	onOpenModelSettings,
	catalogueReady,
	modelPending = false,
	startingEngine,
	startFailed,
	choice,
	onChoiceChange,
	auto,
	choiceUnchosen,
	running,
	stopping = false,
	history = [],
	liveInputSupported = false,
	sending,
	pending,
	trayActions,
	shells,
	usage,
	pullRequest,
	onSend,
	onQueue,
	onStop,
	projectName,
	starters = DEFAULT_STARTERS,
	projectId,
	sessionId,
	projectPath,
	projects,
	onSelectProject,
	computerLabel = 'This computer',
	harnessView,
	harnessBusy = false,
	onHarnessChange,
	onRecheckEngines,
	attachmentsSupported = true,
	reviewModes,
	permissionEngine,
	permissionScope,
	onLeaveProject,
	onOpenProject,
	onCreateProject,
	emptyHeading = DEFAULT_HOME_HEADING,
	emptyHeadingParts,
	empty,
	permissions,
	palNames,
	palRunning,
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
	speechStatus,
	surface,
}: {
	speechControl?: ReactNode
	/** Voice lines (the one-time agreement, "Listening…", what just happened), drawn right above the box. */
	speechStatus?: ReactNode
	/** "Desktop | CLI": CLI sends open the engine's own command line in a terminal tab. */
	surface?: EngineSurfaceControl
	/** Why sending is blocked right now, in words, shown above the text the person may still type. */
	blockedNotice?: string
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
	/** Opens Settings ▸ Models; the empty state's one action when no provider can answer. */
	onOpenModelSettings?: () => void
	/**
	 * The catalogue may be read: it needs the providers, not the draft settings, so it starts
	 * while those still load. Defaults to `modelSelectionReady`.
	 */
	catalogueReady?: boolean
	/** The model choice is still resolving, so the trigger draws no prompt and no raw id. */
	modelPending?: boolean
	startingEngine?: HarnessView['selected']
	/** The engine failed to answer, so "Starting…" would be a claim of progress that no longer holds. */
	startFailed?: boolean
	choice: ModelChoice
	/** Nothing was ever chosen for this pane; the picker settles on the recommended model. */
	choiceUnchosen?: boolean
	onChoiceChange: (choice: ModelChoice, source?: 'person') => void
	/** Auto (the model side decides per task) is offered for this conversation. */
	auto?: { active: boolean; onSelect: () => void }
	running: boolean
	/** Stop was asked for and the reply has not ended yet. */
	stopping?: boolean
	/** What the person sent in this conversation, oldest first, for the up arrow. */
	history?: readonly string[]
	liveInputSupported?: boolean
	sending: boolean
	/** Messages typed while a reply runs, shown in the tray fused to the composer. */
	pending: PendingMessages
	trayActions: ComposerTrayActions
	/** Background shell commands running for this conversation; absent when there are none. */
	shells?: { count: number; onOpen: () => void }
	/** How full the conversation is, as the engine last said; the ring is drawn only when it is complete. */
	usage?: ThreadUsage
	/** The branch's pull request; absent when there is none to show. */
	pullRequest?: { pr: ProjectPrView; onOpen: () => void }
	onSend: () => void
	onQueue?: () => void
	onStop: () => void
	projectName: string
	/** The ideas under an empty conversation; a chat without a project gets ones that need no files. */
	starters?: readonly [string, string, string]
	projectId: string
	sessionId?: string
	projectPath: string
	projects?: readonly ProjectView[]
	onSelectProject?: (project: ProjectView) => void
	computerLabel?: string
	harnessView?: HarnessView
	harnessBusy?: boolean
	onHarnessChange?: (engine: HarnessView['selected']) => void
	/** Reads the engines again, after a program was installed. */
	onRecheckEngines?: () => Promise<unknown>
	attachmentsSupported?: boolean
	reviewModes?: readonly ComposerPermissionMode[]
	permissionEngine?: HarnessView['selected']
	permissionScope?: string
	onLeaveProject?: () => void
	onOpenProject: () => void
	onCreateProject?: () => void
	/** The line above an empty conversation. */
	emptyHeading?: string
	/** The heading in parts, when it names a project: the name is drawn in the display face. */
	emptyHeadingParts?: { before: string; name: string; after: string }
	empty: boolean
	permissions: PermissionView[]
	/** Pal names by ID, for an approval that names a Pal only by ID. */
	palNames?: ReadonlyMap<string, string>
	palRunning?: ReadonlySet<string>
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
	// The tray only helps before the first message. It stays mounted for its short exit.
	const trayWanted = centered
	const [trayPresent, trayDone] = usePresence(trayWanted, sessionId)
	const approvalDisabled = !connected || !toolsAvailable || draftDisabled || harnessBusy
	const [dragging, setDragging] = useState(false)
	const dragDepth = useRef(0)
	const importDisabled =
		sending || attachmentsBusy || draftDisabled || !connected || !attachmentsSupported
	// Removal stays possible on engines that cannot take attachments, so a draft is never stranded.
	const removeDisabled = sending || attachmentsBusy || draftDisabled || !connected
	const attachmentsStranded = attachments.length > 0 && !attachmentsSupported
	const hasDraft = draft.length > 0 || attachments.length > 0
	const [pasteNotice, setPasteNotice] = useState<string>()
	// A notice written by a paste outlives the change event that paste causes, and nothing else.
	const keepPasteNotice = useRef(false)
	const [walk, setWalk] = useState<HistoryWalk | null>(null)
	const walking = activeWalk(walk, draft)
	// Where the caret goes once a recalled message is in the box: its start after an older one, its end after a newer one.
	const caretAfterRecall = useRef<number | null>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the new text is what the caret waits for.
	useLayoutEffect(() => {
		const caret = caretAfterRecall.current
		if (caret === null) return
		caretAfterRecall.current = null
		inputRef.current?.setSelectionRange(caret, caret)
	}, [draft, inputRef])
	const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
	const cliMode = !compact && surface?.value === 'cli'
	// Only a computer with nothing to answer with (not even the free models) shows the card.
	const noProvider = !providersLoading && usableProviders(providers).length === 0 && !cliMode
	// With nothing connected, Enter and the Send button lead to the card that fixes it.
	const focusConnectCard = () =>
		document.getElementById('provider-empty-connect')?.focus({ preventScroll: false })
	const automaticNote =
		empty && !compact && !cliMode && !noProvider
			? automaticChoiceNote(providers, choice, choiceUnchosen === true)
			: undefined
	const cliLabel = engineLabel(harnessView, permissionEngine ?? harnessView?.selected ?? 'namzu')
	const modelControl = (
		<ModelPicker
			projectId={projectId}
			sessionId={sessionId}
			catalogueHarnessScope={permissionEngine ?? harnessView?.selected ?? 'namzu'}
			providers={providers}
			choice={choice}
			unchosen={choiceUnchosen}
			onChange={onChoiceChange}
			auto={auto}
			catalogueEnabled={
				// An explicit `catalogueReady` already answers for the engine switch; `harnessBusy` here also
				// counts tab restore and loading, which must not hold the read back.
				catalogueReady ?? (modelSelectionReady && !harnessBusy)
			}
			pending={modelPending}
			startingEngine={startingEngine}
			startFailed={startFailed}
			unconnected={noProvider}
			disabled={running || sending || !modelSelectionReady || harnessBusy}
			settings={capabilities}
			effort={settings.effort}
			onEffortChange={(effort) => onSettingsChange({ ...settings, effort })}
			engineControl={
				compact
					? undefined
					: {
							view: harnessView,
							selected: permissionEngine,
							busy: harnessBusy,
							disabled: !connected || running || sending,
							onSelect: onHarnessChange ?? (() => {}),
							onRecheck: onRecheckEngines
								? async () => {
										await onRecheckEngines()
									}
								: undefined,
							surface,
						}
			}
		/>
	)
	const settingsControl = (
		<ComposerSettings
			engine={permissionEngine ?? harnessView?.selected}
			permissionScope={permissionScope}
			reviewModes={reviewModes}
			permissionMode={composerPermissionMode(settings.permissionMode)}
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
	// Namzu is only waiting on the person, so stopping is not an emergency.
	const waitingOnPerson = permissions.length > 0
	// While a question waits for the person the composer is a one-line bar: the question is above it.
	const waiting = waitingOnPerson && !compact
	const [plusOpen, setPlusOpen] = useState(false)
	const [trayEditing, setTrayEditing] = useState<string | null>(null)
	const editableRows = pending.rows.filter((row) => row.editable)
	const plusControl = (
		<Popover open={plusOpen} onOpenChange={setPlusOpen}>
			<PopoverTrigger
				render={<Button variant="ghost-muted" size="icon-sm" />}
				className={compact ? 'pal-composer-add' : 'composer-add'}
				aria-label="Attachments and message settings"
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
				// A pick hands the keyboard back to the message box, not to the plus button.
				finalFocus={inputRef}
			>
				<Button
					variant="ghost"
					size="sm"
					className="pal-composer-attach"
					aria-label="Attach files"
					disabled={importDisabled}
					onClick={() => {
						// The menu has done its job; the chip it adds must not sit under it.
						setPlusOpen(false)
						inputRef.current?.focus()
						onAttach()
					}}
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
	const overlay = useRef<HTMLDivElement>(null)
	const previous = useRef<{ top: number; empty: boolean } | null>(null)
	useLayoutEffect(() => {
		const node = overlay.current
		const stage = node?.parentElement
		if (!node || !stage) return
		const update = () => {
			// The big heading sits above the centred box. When the pane is too short to hold it
			// without reaching the tab strip, it is dropped rather than drawn over it.
			const heading = node.querySelector<HTMLElement>('[data-composer-heading]')
			const box = node.querySelector<HTMLElement>('[data-chat-composer-stack]')
			if (heading && box) {
				const fits = box.offsetTop >= heading.offsetHeight + 32 + 8
				if (node.dataset.headingFits !== String(fits)) node.dataset.headingFits = String(fits)
			}
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
		if (stack) observer.observe(stack)
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
					? 'composer-wrap composer-wrap-centered pointer-events-none absolute inset-0 z-20 flex items-center'
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
							<h1
								data-composer-heading
								className="text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl"
							>
								{emptyHeadingParts ? (
									<>
										{emptyHeadingParts.before}
										<HomeHeadingName name={emptyHeadingParts.name} />
										{emptyHeadingParts.after}
									</>
								) : (
									emptyHeading
								)}
							</h1>
						</div>
					)}
					{speechStatus}
					{permissions[0] && (
						<fieldset
							className="m-0 min-w-0 border-0 p-0"
							disabled={approvalDisabled}
							aria-label="Action approval controls"
						>
							<ComposerApproval
								key={permissions[0].id}
								permission={permissions[0]}
								palNames={palNames}
								palRunning={palRunning}
								count={permissions.length}
								folder={projectPath}
								projectName={projectName}
								// Only the Namzu engine keeps an "allow for this conversation" answer.
								conversationAllowance={
									(permissionEngine ?? harnessView?.selected ?? 'namzu') === 'namzu'
								}
								onRespond={(permission, response) =>
									approvalDisabled ? false : onApproval(permission, response)
								}
							/>
						</fieldset>
					)}
					<ComposerSurface.Shell
						className={cn(
							compact ? 'pal-composer-shell' : 'normal-composer-shell',
							pending.rows.length > 0 && 'composer-with-tray',
						)}
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
						<ComposerTray
							pending={pending}
							actions={trayActions}
							editing={trayEditing}
							onEditingChange={setTrayEditing}
						/>
						<ComposerSurface.Host>
							<ComposerSurface.Main className={waiting ? 'composer-waiting' : undefined}>
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
									{walking && (
										<output
											className="block pb-2 text-xs text-muted-foreground"
											data-history-counter
										>
											{historyCounter(walking, history.length)} ·{' '}
											{walking.stash ? '↓ brings back what you were typing' : '↓ goes forward'}
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
									{blockedNotice && (
										<output className="block pb-2 text-xs text-muted-foreground">
											{blockedNotice}
										</output>
									)}
									<Textarea
										unstyled
										className="composer-input"
										aria-label="Message Namzu"
										ref={inputRef}
										value={draft}
										maxLength={DRAFT_LIMIT}
										disabled={draftDisabled}
										placeholder={composerPlaceholder({
											compact,
											cliMode,
											cliLabel,
											editableQueued: editableRows.length > 0,
											waitingOnPerson: waiting,
											hasDraft,
											running,
											liveInputSupported,
											mac,
										})}
										onChange={(event) => {
											if (keepPasteNotice.current) keepPasteNotice.current = false
											else setPasteNotice(undefined)
											setWalk(null)
											onDraftChange(event.target.value)
										}}
										onPaste={(event) => {
											const files = Array.from(event.clipboardData.files)
											const text = event.clipboardData.getData('text/plain')
											const decision = decidePaste({
												text,
												fileCount: files.length,
												importDisabled,
												attachmentsSupported,
											})
											if (decision.action === 'default') {
												const target = event.currentTarget
												const left = pasteOverflow({
													current: target.value,
													selectionStart: target.selectionStart,
													selectionEnd: target.selectionEnd,
													pasted: text,
												})
												keepPasteNotice.current = left > 0
												setPasteNotice(left > 0 ? pasteOverflowNotice(left) : undefined)
												return
											}
											event.preventDefault()
											if (decision.action === 'import') {
												setPasteNotice(undefined)
												onAddFiles(files)
											} else setPasteNotice(decision.notice)
										}}
										onKeyDown={(event) => {
											keepPasteNotice.current = false
											const target = event.currentTarget
											const key = decideComposerKey({
												key: event.key,
												shiftKey: event.shiftKey,
												altKey: event.altKey,
												ctrlKey: event.ctrlKey,
												metaKey: event.metaKey,
												composing: isComposing(event),
												value: target.value,
												selectionStart: target.selectionStart,
												selectionEnd: target.selectionEnd,
												hasDraft,
												editableQueued: editableRows.length > 0,
												trayEditing: trayEditing !== null,
												hasHistory: history.length > 0,
												walking: walking !== null,
												canHold:
													running &&
													liveInputSupported &&
													Boolean(onQueue) &&
													draft.trim().length > 0 &&
													attachments.length === 0 &&
													!sending &&
													!attachmentsStranded,
											})
											switch (key.action) {
												case 'edit-queued':
													event.preventDefault()
													setTrayEditing(editableRows[editableRows.length - 1]?.id ?? null)
													return
												case 'recall': {
													const step = stepHistory(history, walking, draft, key.direction)
													if (!step) return
													event.preventDefault()
													caretAfterRecall.current = caretAfterStep(step.text, key.direction)
													setWalk(step.walk)
													onDraftChange(step.text)
													return
												}
												case 'queue':
													event.preventDefault()
													onQueue?.()
													return
												case 'send':
													event.preventDefault()
													if (noProvider) focusConnectCard()
													else if (!attachmentsStranded) onSend()
													return
												default:
													return
											}
										}}
									/>
								</div>
								<div
									data-chat-composer-footer
									className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
								>
									{!compact && <div className="composer-footer-options">{plusControl}</div>}
									<div className="pal-composer-send-actions flex shrink-0 flex-nowrap items-center justify-end gap-2">
										{compact && !waiting && <ContextRing usage={usage} />}
										{running &&
											liveInputSupported &&
											onQueue &&
											!(waiting && !draft.trim() && attachments.length === 0) && (
												<Tooltip>
													<TooltipTrigger
														render={
															<Button
																variant="ghost-muted"
																size="icon-xs"
																aria-label="Queue message for the next reply"
																disabled={
																	sending ||
																	draftDisabled ||
																	attachmentsStranded ||
																	(!draft.trim() && attachments.length === 0)
																}
																onClick={onQueue}
															/>
														}
													>
														<ListPlusIcon className="size-3.5" aria-hidden="true" />
													</TooltipTrigger>
													<TooltipPopup>
														Hold this message and send it when the current reply is done · Tab
													</TooltipPopup>
												</Tooltip>
											)}
										{!waiting && speechControl}
										{running && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															// Waiting for a decision, Stop is an outline that turns red on hover: the one filled control is the card's Accept.
															className={
																waiting
																	? 'composer-stop-quiet'
																	: 'flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-black/8 active:shadow-none'
															}
															aria-label={stopping ? 'Stopping reply' : 'Stop reply'}
															aria-busy={stopping}
															data-stopping={stopping ? 'true' : undefined}
															disabled={draftDisabled}
															onClick={onStop}
														/>
													}
												>
													{stopping ? (
														<LoaderCircleIcon
															className="composer-send-spinner size-3.5"
															aria-hidden="true"
														/>
													) : (
														<SquareIcon
															className={waiting ? 'size-2.5 fill-current' : 'size-3 fill-current'}
														/>
													)}
												</TooltipTrigger>
												<TooltipPopup>
													{stopping
														? 'Stopping this reply…'
														: stopTooltip({
																waitingOnPerson,
																liveInputSupported,
																queueDisabled:
																	(!draft.trim() && attachments.length === 0) ||
																	sending ||
																	draftDisabled ||
																	attachmentsStranded,
																attachmentsStranded,
															})}
												</TooltipPopup>
											</Tooltip>
										)}
										{(!running || draft.trim() || attachments.length > 0) && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover aria-disabled:opacity-64 aria-disabled:shadow-none aria-disabled:hover:scale-100"
															aria-disabled={noProvider && !cliMode ? true : undefined}
															aria-label={
																cliMode
																	? `Open ${cliLabel} in a terminal`
																	: sending
																		? 'Sending'
																		: running && liveInputSupported && attachments.length === 0
																			? 'Send to current reply'
																			: running
																				? 'Queue message'
																				: 'Send message'
															}
															aria-busy={sending}
															disabled={
																cliMode
																	? !choice.provider || sending || !connected
																	: (!draft.trim() && attachments.length === 0) ||
																		!choice.provider ||
																		sending ||
																		attachmentsBusy ||
																		attachmentsStranded ||
																		!connected
															}
															onClick={(event) => {
																if (noProvider) {
																	focusConnectCard()
																	return
																}
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
													) : cliMode ? (
														<TerminalIcon className="size-3.5" />
													) : (
														<ArrowUpIcon className="size-3.5" strokeWidth={1.8} />
													)}
												</TooltipTrigger>
												<TooltipPopup>
													{cliMode
														? `Open ${cliLabel} in a terminal · Enter`
														: noProvider
															? 'Connect a provider to send'
															: sending
																? 'Sending'
																: running
																	? liveInputSupported && attachments.length === 0
																		? 'Send text to this running reply with its current model and review settings'
																		: 'Queue for the next reply'
																	: 'Send message · Enter'}
												</TooltipPopup>
											</Tooltip>
										)}
									</div>
								</div>
							</ComposerSurface.Main>
						</ComposerSurface.Host>
					</ComposerSurface.Shell>
					{!compact && (
						<div className="composer-row" data-composer-row>
							<div className="composer-row-inner">
								<div className="composer-row-start">
									{trayPresent && (
										<div
											className="composer-row-project"
											data-leaving={!trayWanted || undefined}
											onAnimationEnd={trayDone}
										>
											<ComposerProjectPicker
												computerLabel={computerLabel}
												projectId={projectId}
												projectName={projectName}
												projectPath={projectPath}
												projects={projects}
												onLeaveProject={onLeaveProject}
												onSelectProject={onSelectProject}
												onOpenProject={onOpenProject}
												onCreateProject={onCreateProject}
											/>
										</div>
									)}
									<ComposerPermissions
										engine={permissionEngine ?? harnessView?.selected}
										permissionScope={permissionScope}
										permissionMode={composerPermissionMode(settings.permissionMode)}
										reviewModes={reviewModes}
										disabled={sending || !connected}
										onChange={(permissionMode) => onSettingsChange({ ...settings, permissionMode })}
									/>
									{!waiting && shells && shells.count > 0 && (
										<Button
											variant="ghost-muted"
											size="xs"
											className="composer-footer-chip"
											data-composer-shells={shells.count}
											aria-label={`${shells.count} background ${shells.count === 1 ? 'shell' : 'shells'} running. Show`}
											onClick={shells.onOpen}
										>
											{shells.count} {shells.count === 1 ? 'shell' : 'shells'}
										</Button>
									)}
									{!waiting && pullRequest && (
										<Button
											variant="ghost-muted"
											size="xs"
											className="composer-footer-chip composer-pr"
											data-composer-pr={pullRequest.pr.number}
											data-review={pullRequest.pr.review}
											aria-label={`Pull request ${pullRequest.pr.number}, ${REVIEW_WORDS[pullRequest.pr.review]}. Open in browser`}
											title={REVIEW_WORDS[pullRequest.pr.review]}
											onClick={pullRequest.onOpen}
										>
											PR #{pullRequest.pr.number}
										</Button>
									)}
								</div>
								<div className="composer-row-end">
									<div className="composer-selected-model">{modelControl}</div>
									<ContextReadout usage={usage} />
								</div>
							</div>
						</div>
					)}
					{empty &&
						!compact &&
						draft.length === 0 &&
						attachments.length === 0 &&
						!noProvider &&
						providers.available.length > 0 && (
							<div className="starter-actions" aria-label="Ideas to get started">
								{[SearchIcon, FileDiffIcon, ListTodoIcon].map((Icon, index) => {
									const label = starters[index]
									return (
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
									)
								})}
							</div>
						)}
					{automaticNote && (
						<p className="provider-auto-note" data-slot="provider-auto-note">
							{automaticNote}
						</p>
					)}
					{noProvider && (
						<section className="provider-empty" aria-labelledby="provider-empty-title">
							<h2 id="provider-empty-title">Add an API key or sign in to start</h2>
							<p>{PROVIDER_EMPTY_HELP}</p>
							{onOpenModelSettings ? (
								<Button id="provider-empty-connect" size="sm" onClick={onOpenModelSettings}>
									Connect a provider
								</Button>
							) : (
								<p>Open Settings, then Models.</p>
							)}
						</section>
					)}
					<div aria-hidden className="h-3" />
				</div>
			</div>
		</div>
	)
}
