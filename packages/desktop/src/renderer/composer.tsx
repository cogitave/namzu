import type { ReviewMode } from '@namzu/sdk'
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
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
import { type AddMenuToolServers, ComposerAddMenu } from './composer-add-menu.js'
import { ComposerApproval } from './composer-approval.js'
import { caretPoint, copyBoxText } from './composer-caret.js'
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
	composerPlaceholderTitle,
	decidePaste,
	pasteOverflow,
	pasteOverflowNotice,
	stopTooltip,
} from './composer-input.js'
import { decideComposerKey, isComposing } from './composer-keys.js'
import { placeListMenu } from './composer-list-menu.js'
import { type MentionIndex, mentionList } from './composer-mention-list.js'
import { ComposerMentionMenu, MENTION_MENU_ID } from './composer-mention-menu.js'
import {
	activeMention,
	applyMention,
	filterSlash,
	mentionPieces,
	mentionText,
	mirrorParts,
	moveHighlight,
	pickSlash,
	slashLine,
	slashQuery,
} from './composer-menu-model.js'
import { defaultPermissionModes } from './composer-permissions.js'
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
import { ComposerSlashMenu, SLASH_MENU_ID } from './composer-slash-menu.js'
import { ComposerSurface } from './composer-surface.js'
import { ComposerTray, type ComposerTrayActions } from './composer-tray.js'
import { prepareIndex } from './file-panel/file-search.js'
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
	TerminalIcon,
} from './icons.js'
import { cn } from './lib/utils.js'
import { effortLabel } from './model-choice.js'
import { HYPERMODE_BLOCKED, type ModelChoice, ModelPicker } from './model-picker.js'
import { isMaterialPaste } from './paste-ranges.js'
import type { PendingMessages } from './pending-messages.js'
import { usePresence } from './presence.js'
import { DEFAULT_HOME_HEADING } from './project-home.js'
import { type SlashHandlers, type SlashRow, slashRows, slashRowsHeldBack } from './slash-actions.js'
import { Button } from './ui/button.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Textarea } from './ui/textarea.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './composer.css'
import type { ThreadUsage } from '../shared/projection.js'
import type { ContextPanelSource } from './context-panel.js'
import { ContextReadout, ContextRing } from './context-ring-view.js'
import { UsageIndicator, type UsageLimitsControl, indicatorState } from './usage-limits-popover.js'

/**
 * The picker's modes are the ones this window offers. The kernel's old `auto`,
 * saved by earlier versions as Full access, is shown as Full access (`bypass`).
 */
function composerPermissionMode(mode: ReviewMode | undefined): ComposerPermissionMode {
	return mode === 'auto' ? 'bypass' : (mode ?? 'prompt')
}

const PROVIDER_EMPTY_HELP =
	'Namzu needs an AI service to reply. Add a key for one, or sign in to Claude Code or Codex and Namzu will use that.'

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
	onMaterialPaste,
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
	limits,
	contextPanel,
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
	notice,
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
	slashHandlers,
	loadProjectFiles,
	toolServers,
}: {
	/** What the "/" list can run here; a command without a handler is not listed. */
	slashHandlers?: SlashHandlers
	/** Reads the project's file list for the "@" list; absent where files cannot be named. */
	loadProjectFiles?: (projectId: string) => Promise<{ paths: string[]; truncated: boolean }>
	/** The plus menu's tool server list; absent where the project has none to show. */
	toolServers?: AddMenuToolServers
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
	/** Text the person pasted that is long enough to be material, and where it went. */
	onMaterialPaste?: (paste: { start: number; text: string }) => void
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
	/** What the account behind the provider says about its limits; the indicator opens a popover with it. */
	limits?: UsageLimitsControl
	/** Lets the ring open the context panel; absent when the engine cannot say where the window goes. */
	contextPanel?: ContextPanelSource
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
	/** One line the app wants said under the box, such as a mode that was closed since last time. */
	notice?: string
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
	// Something to send: text or an attachment. Only then does the box show its send control.
	const hasContent = draft.trim().length > 0 || attachments.length > 0
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
	const [caret, setCaret] = useState(0)
	const [focused, setFocused] = useState(false)
	useEffect(() => {
		setFocused(document.activeElement === inputRef.current)
	}, [inputRef])
	// Esc closes a list and keeps the text; the list stays closed until what it was asked about changes.
	const [dismissed, setDismissed] = useState<string | null>(null)
	const [highlight, setHighlight] = useState({ key: '', index: 0 })
	const [modelRequest, setModelRequest] = useState(0)
	const [permissionRequest, setPermissionRequest] = useState(0)
	const [, setViewport] = useState(0)
	const hostRef = useRef<HTMLElement | null>(null)
	const stackRef = useRef<HTMLDivElement>(null)
	const mirrorRef = useRef<HTMLDivElement>(null)
	const cliMode = !compact && surface?.value === 'cli'
	const commandsEnabled = !compact && !cliMode && !draftDisabled
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
	// Hypermode is Namzu's own mode, for any level of effort; another engine has no such switch, and
	// a Pal keeps its own settings.
	const hypermodeOffered =
		!compact && (permissionEngine ?? harnessView?.selected ?? 'namzu') === 'namzu'
	// The commands this box can run: the window's own (from the caller) and the ones it owns itself.
	const handlers = useMemo<SlashHandlers>(() => {
		if (!commandsEnabled) return {}
		const own: SlashHandlers = { ...slashHandlers }
		const settingsReady = !sending && connected && toolsAvailable
		if (modelSelectionReady && !running && !sending && !harnessBusy && !noProvider)
			own.model = () => setModelRequest((count) => count + 1)
		const levels = capabilities?.effortLevels
		if (hypermodeOffered && !running && !sending && connected) {
			// `/effort hypermode on|off` changes only the mode; `/effort high hypermode on` the level too.
			own.effort = (argument) => {
				const words = argument.trim().toLowerCase().split(/\s+/).filter(Boolean)
				const modeAt = words.length >= 2 ? words.length - 2 : -1
				let mode: boolean | undefined
				let rest = words
				if (modeAt >= 0 && words[modeAt] === 'hypermode') {
					const choice = words[modeAt + 1]
					if (choice !== 'on' && choice !== 'off') return `/effort ${argument}`
					mode = choice === 'on'
					rest = words.slice(0, modeAt)
				}
				const next: DesktopSendOptions = { ...settings }
				if (mode !== undefined) {
					// Refused with the one sentence; a level typed with it is still applied.
					if (mode && capabilities?.workflowsOff) setPasteNotice(HYPERMODE_BLOCKED)
					else next.hypermode = mode
				}
				if (rest.length === 0) {
					if (mode === undefined) {
						setModelRequest((count) => count + 1)
						return undefined
					}
					onSettingsChange(next)
					return undefined
				}
				const word = rest.join(' ')
				if (word === 'default' || word === 'auto') {
					onSettingsChange({ ...next, effort: undefined })
					return undefined
				}
				const level = levels?.find(
					(item) =>
						item === word ||
						effortLabel(item).toLowerCase() === word ||
						(word === 'extra' && item === 'xhigh'),
				)
				if (!level) return `/effort ${argument}`
				onSettingsChange({ ...next, effort: level })
				return undefined
			}
		} else if (levels?.length && !running && !sending && connected) {
			own.effort = (argument) => {
				const word = argument.trim().toLowerCase()
				if (!word) {
					setModelRequest((count) => count + 1)
					return undefined
				}
				if (word === 'default' || word === 'auto') {
					onSettingsChange({ ...settings, effort: undefined })
					return undefined
				}
				const level = levels.find(
					(item) =>
						item === word ||
						effortLabel(item).toLowerCase() === word ||
						(word === 'extra' && item === 'xhigh'),
				)
				if (!level) return `/effort ${argument}`
				onSettingsChange({ ...settings, effort: level })
				return undefined
			}
		}
		const modes =
			reviewModes ?? defaultPermissionModes(permissionEngine ?? harnessView?.selected ?? 'namzu')
		if (settingsReady && modes.includes('plan'))
			own.plan = (argument) => {
				onSettingsChange({ ...settings, permissionMode: 'plan' })
				return argument.trim() || undefined
			}
		if (settingsReady) own.permissions = () => setPermissionRequest((count) => count + 1)
		return own
	}, [
		commandsEnabled,
		slashHandlers,
		sending,
		connected,
		toolsAvailable,
		modelSelectionReady,
		running,
		harnessBusy,
		noProvider,
		capabilities?.effortLevels,
		capabilities?.workflowsOff,
		hypermodeOffered,
		settings,
		onSettingsChange,
		reviewModes,
		permissionEngine,
		harnessView?.selected,
	])
	const rows = useMemo(
		() => slashRows(handlers, { newConversation: centered }),
		[handlers, centered],
	)
	const moreLater = slashRowsHeldBack(handlers, centered)
	const query = commandsEnabled && focused ? slashQuery(draft, caret) : null
	const matches = useMemo(() => (query === null ? [] : filterSlash(rows, query)), [rows, query])
	const slashKey = `s:${query}`
	const slashOpen = query !== null && matches.length > 0 && dismissed !== slashKey
	const slashIndex = Math.min(highlight.key === slashKey ? highlight.index : 0, matches.length - 1)
	const mention =
		commandsEnabled && focused && loadProjectFiles && !slashOpen && query === null
			? activeMention(draft, caret)
			: null
	const mentionKey = mention ? `m:${mention.start}:${mention.query}` : ''
	// The file list is read the first time "@" is typed, then kept for this project.
	const [files, setFiles] = useState<{ projectId: string; value: MentionIndex } | null>(null)
	const wantFiles = mention !== null && files?.projectId !== projectId
	// The project whose list was asked for last; an answer for another project is dropped.
	const askedFiles = useRef<string | null>(null)
	useEffect(() => {
		if (!wantFiles || !loadProjectFiles) return
		askedFiles.current = projectId
		setFiles({ projectId, value: { state: 'loading' } })
		loadProjectFiles(projectId).then(
			(found) => {
				if (askedFiles.current !== projectId) return
				setFiles({
					projectId,
					value: { state: 'ready', index: prepareIndex(found.paths), truncated: found.truncated },
				})
			},
			() => {
				if (askedFiles.current === projectId) setFiles({ projectId, value: { state: 'failed' } })
			},
		)
	}, [wantFiles, loadProjectFiles, projectId])
	const mentionView = useMemo(
		() =>
			mention && files?.projectId === projectId
				? mentionList(files.value, mention.query)
				: ({ kind: 'closed' } as const),
		[mention, files, projectId],
	)
	const shownMention =
		mention !== null && mentionView.kind !== 'closed' && dismissed !== mentionKey
			? mentionView
			: null
	const mentionOpen = shownMention !== null
	const mentionRows = mentionView.kind === 'rows' ? mentionView.rows : []
	const mentionIndex = Math.min(
		highlight.key === mentionKey ? highlight.index : 0,
		Math.max(0, mentionRows.length - 1),
	)
	const menuOpen = slashOpen ? 'slash' : mentionOpen ? 'mention' : null
	// A list that was closed with Esc opens again once what it was asked about is something else.
	useEffect(() => {
		if (dismissed !== null && dismissed !== slashKey && dismissed !== mentionKey) setDismissed(null)
	}, [dismissed, slashKey, mentionKey])
	// Files picked from the "@" list stay coloured in the box, as a picked "/name" does.
	const [pickedMentions, setPickedMentions] = useState<readonly string[]>([])
	const livePicked = pickedMentions.filter((token) => draft.includes(token))
	const mirror =
		(commandsEnabled ? mirrorParts(rows, draft, slashOpen) : null) ??
		(livePicked.length > 0 ? { command: '', rest: draft } : null)
	// A window that changes size moves where a list belongs.
	useEffect(() => {
		if (!menuOpen) return
		const again = () => setViewport((count) => count + 1)
		window.addEventListener('resize', again)
		return () => window.removeEventListener('resize', again)
	}, [menuOpen])
	// The box this one's lists and menus sit on.
	useLayoutEffect(() => {
		hostRef.current = inputRef.current?.closest<HTMLElement>('[data-slot="composer-host"]') ?? null
	})
	// The layer behind the box takes the box's type, padding and size, and follows its scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: it is redrawn with every change of the text it paints.
	useLayoutEffect(() => {
		const box = inputRef.current
		const layer = mirrorRef.current
		const stack = stackRef.current
		if (!box || !layer || !stack) return
		copyBoxText(box, layer)
		const boxRect = box.getBoundingClientRect()
		const stackRect = stack.getBoundingClientRect()
		layer.style.top = `${boxRect.top - stackRect.top + box.clientTop}px`
		layer.style.left = `${boxRect.left - stackRect.left + box.clientLeft}px`
		layer.style.width = `${box.clientWidth}px`
		layer.style.height = `${box.clientHeight}px`
		layer.scrollTop = box.scrollTop
	}, [mirror?.command, mirror?.rest, mirror?.ghost, draft, inputRef, livePicked.length])
	// Where the "/" list sits: flush on the box's top edge, its left 16 before the text.
	const placeSlash = () => {
		const box = inputRef.current
		const host = hostRef.current
		if (!box || !host) return placeListMenu({ left: 8, bottomEdge: 0, width: 240 })
		const textLeft =
			box.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(box).paddingLeft || '0')
		return placeListMenu({
			left: textLeft - 16,
			bottomEdge: host.getBoundingClientRect().top,
			width: 240,
		})
	}
	// Where the "@" list sits: its left at the "@", its bottom on the top of the line that holds it.
	const placeMention = () => {
		const box = inputRef.current
		if (!box || !mention) return placeListMenu({ left: 8, bottomEdge: 0, width: 420 })
		const point = caretPoint(box, mention.start)
		return placeListMenu({ left: point.x, bottomEdge: point.lineTop, width: 420 })
	}
	const runRow = (row: SlashRow, argument: string) => {
		const back = row.run(argument)
		if (typeof back === 'string') {
			caretAfterRecall.current = back.length
			onDraftChange(back)
			setCaret(back.length)
		}
	}
	const pickRow = (row: SlashRow) => {
		const pick = pickSlash(row)
		setWalk(null)
		setDismissed(null)
		if (pick.run) {
			onDraftChange('')
			setCaret(0)
			runRow(row, '')
			return
		}
		caretAfterRecall.current = pick.text.length
		onDraftChange(pick.text)
		setCaret(pick.text.length)
	}
	const pickFile = (path: string) => {
		if (!mention) return
		const next = applyMention(draft, caret, mention, path)
		const token = mentionText(path).trimEnd()
		setPickedMentions((list) => (list.includes(token) ? list : [...list, token]))
		caretAfterRecall.current = next.caret
		setWalk(null)
		onDraftChange(next.value)
		setCaret(next.caret)
	}
	// Enter and the send button first ask whether the box holds a command; one runs and sends no reply.
	const submit = () => {
		if (commandsEnabled) {
			const line = slashLine(rows, draft)
			const row = line && rows.find((item) => item.name === line.entry.name)
			if (row && line) {
				setWalk(null)
				onDraftChange('')
				setCaret(0)
				runRow(row, line.argument)
				return
			}
		}
		onSend()
	}
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
			openRequest={modelRequest}
			pending={modelPending}
			startingEngine={startingEngine}
			startFailed={startFailed}
			unconnected={noProvider}
			disabled={running || sending || !modelSelectionReady || harnessBusy}
			settings={capabilities}
			effort={settings.effort}
			onEffortChange={(effort) => onSettingsChange({ ...settings, effort })}
			{...(hypermodeOffered
				? {
						hypermode: {
							on: settings.hypermode ?? capabilities?.hypermodeDefault === true,
							onChange: (on: boolean) => onSettingsChange({ ...settings, hypermode: on }),
						},
					}
				: {})}
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
	const limitsCritical = limits ? indicatorState(usage, limits)?.limits?.critical : undefined
	const [plusOpen, setPlusOpen] = useState(false)
	// Send and Stop share one slot, so Stop can appear under a pointer that is already resting there. No
	// pointer-enter reaches a button that was not there, so Stop's tooltip also opens on the first move.
	const [stopTipOpen, setStopTipOpen] = useState(false)
	const [trayEditing, setTrayEditing] = useState<string | null>(null)
	const editableRows = pending.rows.filter((row) => row.editable)
	const popoverPlus = (
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
	const plusControl = compact ? (
		popoverPlus
	) : (
		<ComposerAddMenu
			open={plusOpen}
			onOpenChange={(next) => {
				setPlusOpen(next)
				// Closing hands the keyboard back to the box, whichever way the menu was left.
				if (!next) requestAnimationFrame(() => inputRef.current?.focus())
			}}
			inputRef={inputRef}
			hostRef={hostRef}
			mac={mac}
			triggerClassName="composer-add"
			attach={attachmentsSupported ? { disabled: importDisabled, onAttach } : null}
			slash={
				commandsEnabled && draft === '' && rows.length > 0
					? {
							onOpen: () => {
								setDismissed(null)
								caretAfterRecall.current = 1
								onDraftChange('/')
								setCaret(1)
								setFocused(true)
								requestAnimationFrame(() => inputRef.current?.focus())
							},
						}
					: null
			}
			toolServers={toolServers ?? null}
			plugins={
				pluginsSupported
					? {
							scope: JSON.stringify([projectId, sessionId, choice.provider, choice.model]),
							view: plugins && {
								...plugins,
								canChange: plugins.canChange && !running && permissions.length === 0,
							},
							loading: pluginsLoading,
							disabled: sending || !connected,
							onOpen: onOpenPlugins,
							onSetEnabled: onSetPluginEnabled,
						}
					: null
			}
		/>
	)
	const overlay = useRef<HTMLDivElement>(null)
	const dock = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const node = overlay.current
		const stage = node?.parentElement
		const bottom = dock.current
		if (!node || !stage || !bottom) return
		// The transcript and the toasts keep clear of the dock, so they read its height.
		const update = () => {
			const height = `${bottom.getBoundingClientRect().height}px`
			if (stage.style.getPropertyValue('--composer-height') !== height)
				stage.style.setProperty('--composer-height', height)
		}
		// The home screen's block keeps its place while the dock grows, so it reads the height in the
		// frame the dock changes in: written in the observer's own delivery, before the next paint, it
		// never shows the block moved for a frame. It changes only the size of a sibling the observer
		// does not watch, so it cannot feed back into it.
		const syncDock = () => {
			const height = `${bottom.getBoundingClientRect().height}px`
			if (stage.style.getPropertyValue('--composer-dock') !== height)
				stage.style.setProperty('--composer-dock', height)
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
		const observer = new ResizeObserver(() => {
			syncDock()
			scheduleResize()
		})
		observer.observe(bottom)
		update()
		syncDock()
		return () => {
			observer.disconnect()
			if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
		}
	}, [])
	const startersShown = empty && !compact && !noProvider && providers.available.length > 0
	// Once something is typed the starters step out of sight but keep their room, so the heading stays put.
	const startersQuiet = draft.length > 0 || attachments.length > 0
	return (
		<div
			ref={overlay}
			data-chat-composer-overlay
			data-composer-variant={variant}
			className="composer-wrap pointer-events-none absolute inset-0 z-20 flex flex-col justify-end"
		>
			{centered && (
				<div className="composer-home" data-composer-home>
					<div className="composer-home-block">
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
						{startersShown && (
							<div
								className="starter-actions"
								aria-label="Ideas to get started"
								data-quiet={startersQuiet || undefined}
							>
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
					</div>
				</div>
			)}
			<div ref={dock} data-composer-dock className="w-full shrink-0">
				<div
					data-chat-composer-stack
					className="composer-column group/composer-stack pointer-events-auto relative z-10"
				>
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
					{/* A note about the conversation itself sits above the box, never inside what you type in. */}
					{notice && (
						<output data-composer-note className="block px-3 pb-1.5 text-xs text-muted-foreground">
							{notice}
						</output>
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
									className="relative"
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
									<div ref={stackRef} className="composer-input-stack">
										<Textarea
											unstyled
											data-mirror={mirror ? '' : undefined}
											role={menuOpen ? 'combobox' : undefined}
											aria-expanded={menuOpen ? true : undefined}
											aria-controls={
												menuOpen === 'slash'
													? SLASH_MENU_ID
													: menuOpen === 'mention'
														? MENTION_MENU_ID
														: undefined
											}
											aria-activedescendant={
												menuOpen === 'slash'
													? `${SLASH_MENU_ID}-${slashIndex}`
													: menuOpen === 'mention' && mentionRows.length > 0
														? `${MENTION_MENU_ID}-${mentionIndex}`
														: undefined
											}
											aria-autocomplete={menuOpen ? 'list' : undefined}
											onFocus={() => setFocused(true)}
											onBlur={() => setFocused(false)}
											onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
											onScroll={(event) => {
												if (mirrorRef.current)
													mirrorRef.current.scrollTop = event.currentTarget.scrollTop
											}}
											className="composer-input"
											aria-label="Message Namzu"
											ref={inputRef}
											value={draft}
											maxLength={DRAFT_LIMIT}
											disabled={draftDisabled}
											title={composerPlaceholderTitle({
												cliMode,
												editableQueued: editableRows.length > 0,
												waitingOnPerson: waiting,
												hasDraft,
												running,
												liveInputSupported,
												mac,
											})}
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
												slashMenu: commandsEnabled && !centered,
											})}
											onChange={(event) => {
												if (keepPasteNotice.current) keepPasteNotice.current = false
												else setPasteNotice(undefined)
												setWalk(null)
												setCaret(event.target.selectionStart)
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
													if (isMaterialPaste(text))
														onMaterialPaste?.({ start: target.selectionStart, text })
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
													menu: menuOpen,
													canAttach: !importDisabled,
													mac,
												})
												switch (key.action) {
													case 'menu': {
														event.preventDefault()
														if (key.step === 'close') {
															event.stopPropagation()
															event.nativeEvent.stopImmediatePropagation()
															setDismissed(menuOpen === 'slash' ? slashKey : mentionKey)
															return
														}
														if (menuOpen === 'slash') {
															if (key.step === 'pick') {
																const row = matches[slashIndex]
																if (row) pickRow(row)
															} else
																setHighlight({
																	key: slashKey,
																	index: moveHighlight(slashIndex, key.step, matches.length),
																})
														} else if (key.step === 'pick') {
															const row = mentionRows[mentionIndex]
															if (row) pickFile(row.path)
														} else
															setHighlight({
																key: mentionKey,
																index: moveHighlight(mentionIndex, key.step, mentionRows.length),
															})
														return
													}
													case 'attach':
														event.preventDefault()
														inputRef.current?.focus()
														onAttach()
														return
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
														if (commandsEnabled && slashLine(rows, draft)) submit()
														else if (noProvider) focusConnectCard()
														else if (!attachmentsStranded) onSend()
														return
													default:
														return
												}
											}}
										/>
										<div
											ref={mirrorRef}
											className="composer-mirror"
											aria-hidden="true"
											hidden={!mirror}
										>
											{mirror && (
												<>
													{mirror.command && (
														<span className="composer-mirror-command">{mirror.command}</span>
													)}
													{mentionPieces(mirror.rest, livePicked).map((piece, at) =>
														piece.mention ? (
															<span key={`${at}:${piece.text}`} className="composer-mirror-command">
																{piece.text}
															</span>
														) : (
															piece.text
														),
													)}
													{mirror.ghost && (
														<span className="composer-mirror-ghost">{mirror.ghost}</span>
													)}
												</>
											)}
										</div>
									</div>
								</div>
								<div
									data-chat-composer-footer
									className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible"
								>
									{!compact && <div className="composer-footer-options">{plusControl}</div>}
									<div className="pal-composer-send-actions flex shrink-0 flex-nowrap items-center justify-end gap-2">
										{compact &&
											!waiting &&
											(limits ? (
												<UsageIndicator usage={usage} control={limits} variant="ring" />
											) : (
												<ContextRing
													usage={usage}
													{...(contextPanel ? { panel: contextPanel } : {})}
												/>
											))}
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
											<Tooltip open={stopTipOpen} onOpenChange={setStopTipOpen}>
												<TooltipTrigger
													onPointerMove={() => setStopTipOpen(true)}
													render={
														<button
															type="button"
															className="composer-stop"
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
														<span className="composer-stop-square" aria-hidden="true" />
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
										{(cliMode ? !running || hasContent : hasContent) && (
											<Tooltip>
												<TooltipTrigger
													render={
														<button
															type="button"
															className="composer-send"
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
																submit()
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
															? 'Connect an AI service to send'
															: sending
																? 'Sending'
																: running
																	? liveInputSupported && attachments.length === 0
																		? 'Add this to the reply in progress. It keeps the current model and approvals.'
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
										openRequest={permissionRequest}
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
									{limits ? (
										<UsageIndicator usage={usage} control={limits} variant="readout" />
									) : (
										<ContextReadout
											usage={usage}
											{...(contextPanel ? { panel: contextPanel } : {})}
										/>
									)}
								</div>
							</div>
						</div>
					)}
					{limitsCritical && (
						<p className="composer-limit-note" data-usage-critical="">
							{limitsCritical}
						</p>
					)}
					{noProvider && (
						<section className="provider-empty" aria-labelledby="provider-empty-title">
							<h2 id="provider-empty-title">Add a key or sign in to start</h2>
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
					{slashOpen && (
						<ComposerSlashMenu
							place={placeSlash()}
							rows={matches}
							highlight={slashIndex}
							onHighlight={(index) => setHighlight({ key: slashKey, index })}
							onPick={pickRow}
							note={
								moreLater && query === ''
									? 'More commands appear once the conversation starts'
									: undefined
							}
						/>
					)}
					{shownMention && (
						<ComposerMentionMenu
							place={placeMention()}
							list={shownMention}
							highlight={mentionIndex}
							onHighlight={(index) => setHighlight({ key: mentionKey, index })}
							onPick={(row) => pickFile(row.path)}
						/>
					)}
					<div aria-hidden className="composer-dock-foot" />
				</div>
			</div>
		</div>
	)
}
