/**
 * TUI root. Composes the banner, transcript, composer, status bar, and
 * the first-run provider picker overlay.
 *
 * Session lifecycle:
 *   1. Mount → probeAgentSession() (readPreferences + discoverProviders).
 *   2. If a current preferences file exists → createAgentSession(prefs, detected) → ready.
 *   3. With no preferences, reuse one signed-in installed-harness subscription
 *      directly, or ask between available subscriptions when there is a choice.
 *   4. Otherwise show <Picker/>. An explicit picker choice is persisted;
 *      automatic reuse is not mistaken for a durable operator preference.
 */

import { join, relative } from 'node:path'
import {
	type CostInfo,
	DiskMessageFeedbackStore,
	type GoalRoundAuthority,
	GoalRoundLimitError,
	HostCommandRegistry,
	type Message,
	type MessageAttachment,
	type MessageId,
	type ReasoningEffort,
	type RunId,
	type SessionGoal,
	SessionGoalActivation,
	type SessionId,
	StaleGoalError,
	asSessionId,
	createAssistantMessage,
	createUserMessage,
	generateRunId,
	isCompactionMessage,
	kernelHostCommands,
} from '@namzu/sdk'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	pinTrustedProjectPath,
	resolveTrustedProjectContext,
} from '../config/trusted-project-context.js'
import { visibleProjectInstructionPath } from '../context/project-path.js'
import { runtimeContextLabel } from '../context/runtime-message.js'

import { writeClipboardText } from '../integrations/clipboard/text.js'
import {
	type TerminalNotification,
	terminalNotificationEnabled,
	writeTerminalNotification,
} from '../integrations/notifications/terminal.js'
import {
	type CodexDeviceLogin,
	type DetectedProvider,
	type Preferences,
	type ProviderId,
	type SubscriptionLogin,
	type SubscriptionProviderId,
	beginCodexDeviceLogin,
	beginSubscriptionLogin,
	clearAllStoredCredentials,
	clearStoredCodexCredential,
	clearStoredSubscriptionCredential,
	credentialsPath,
	parsePastedInput,
	primaryProvider,
	readStoredCodexCredential,
	readStoredSubscriptionCredential,
	signedInSubscriptionProviders,
	writePreferences,
} from '../integrations/providers/index.js'
import {
	type CliSessions,
	type RecentConversation,
	appendMessages,
	archiveConversation,
	forkConversation,
	forkConversationBeforeUser,
	listRecent,
	loadConversation,
	loadResumableConversation,
	openSessions,
	replaceConversation,
	requireWritableConversation,
	setTitle,
	startConversation,
	titleOf,
} from '../integrations/sessions/store.js'
import {
	conversationMarkdown,
	writeConversationExport,
} from '../integrations/sessions/transcript-export.js'
import type {
	ConversationTurnOutcome,
	ConversationTurnStartedRecord,
} from '../integrations/sessions/turn-evidence.js'
import { isTrusted, trustDir } from '../integrations/trust/store.js'
import { checkUpdates } from '../integrations/updates.js'
import { appendMemory, composeMemoryPrompt, readMemory } from '../memory/store.js'
import type { PermissionMode } from '../permissions/mode.js'
import { composeSkillsPrompt, discoverSkills, loadSkillBody } from '../skills/store.js'
import { type UserCommand, discoverUserCommands } from '../user-commands/store.js'
import { ChoicePicker, type ChoicePickerOption } from './ChoicePicker.js'
import {
	Composer,
	type ComposerDraft,
	type ComposerSubmitMode,
	suggestionWindowSize,
} from './Composer.js'
import { CopyPicker } from './CopyPicker.js'
import { EditPromptPicker } from './EditPromptPicker.js'
import { type ActiveTool, LiveActivity, formatElapsed } from './LiveActivity.js'
import { PermissionOverlay } from './PermissionOverlay.js'
import { Picker } from './Picker.js'
import { ResumePicker } from './ResumePicker.js'
import { type ContextFill, StatusBar } from './StatusBar.js'
import { TextPrompt } from './TextPrompt.js'
import { Transcript, willCollapse } from './Transcript.js'
import { terminalSupportsHyperlinks } from './terminal-hyperlinks.js'
import { TrustPrompt } from './TrustPrompt.js'
import {
	type AgentEvent,
	type AgentSession,
	type PermissionDecision,
	type PermissionRequest,
	type RunScope,
	createAgentSession,
	probeAgentSession,
} from './agent.js'
import { bottomSpacerRows } from './bottom-spacer.js'
import { keepRecentRows } from './compact-transcript.js'
import { approvalIsDeliberate } from './consent-timing.js'
import { planTurnPublication } from './conversation-history.js'
import { type CopyResponseTarget, copyTargetsForResponse } from './copy-targets.js'
import { type EditablePrompt, editablePrompts } from './edit-prompts.js'
import type { TuiExitSummary } from './exit-summary.js'
import { MAX_LIVE_ROWS, liveWindow, transcriptLines } from './live-window.js'
import {
	describeCodexDeviceLoginStart,
	describeLoginOutcome,
	describeLoginStart,
	describeLogout,
	describeProviderLogout,
} from './login-prompt.js'
import {
	NAMZU_MARK,
	NAMZU_MARK_COLOR,
	NAMZU_WORDMARK,
	NAMZU_WORDMARK_GRADIENT,
	NAMZU_WORDMARK_MIN_WIDTH,
} from './logo.js'
import { expandFileMentions, listMentionableFiles } from './mentions.js'
import { openInBrowser } from './open-browser.js'
import {
	type CommandPickerEntry,
	type SlashContext,
	baseBranchReviewPrompt,
	commitReviewPrompt,
	hostCommandNames,
	kernelCommandDescriptors,
	mergeHostCommands,
	renderOutcome,
	reviewPrompt,
	runSlash,
} from './slashCommands.js'
import { splitCompleteBlocks } from './stream-blocks.js'
import { moveSelection } from './selection-window.js'
import { theme } from './theme.js'
import type { TranscriptMessage, TuiContext } from './types.js'
import { useSelectionIndex } from './use-selection-index.js'
import { editDraftInExternalEditor } from './external-editor.js'
import { renderWorkspaceDiff, workspaceDiff } from './workspace-diff.js'
import {
	type ReviewCommit,
	listReviewBranches,
	listReviewCommits,
	reviewMergeBase,
} from './workspace-review.js'

export interface AppProps {
	readonly ctx: TuiContext
	readonly onExitSummary?: (summary: TuiExitSummary) => void
	/** Test/embedding seam; the normal TUI uses VISUAL/EDITOR on the host. */
	readonly externalEditor?: ExternalEditorAdapter
}

export type ExternalEditorAdapter = (request: {
	readonly seed: string
	readonly cwd: string
	readonly signal: AbortSignal
}) => Promise<string>

type LifecyclePhase = 'trust' | 'probing' | 'picker' | 'ready' | 'unhealthy' | 'resume' | 'edit'
type ConversationMutation = 'fork' | 'edit' | 'new' | 'archive'
type PendingExternalEditor = {
	readonly token: object
	readonly seed: string
	readonly controller: AbortController
	readonly resolve: (text: string) => void
	readonly reject: (error: unknown) => void
}
type CopyPickerState = {
	readonly targets: readonly CopyResponseTarget[]
	readonly provenance: 'normal-completion' | 'persisted'
}
type ReviewPreset = 'base-branch' | 'uncommitted' | 'commit' | 'custom'
type TextPromptState = {
	readonly token: number
	readonly kind: 'conversation-title' | 'export-file'
	readonly title: string
	readonly placeholder: string
	readonly emptyNotice: string
	readonly initialValue: string
	readonly sessionId: SessionId
}
type ConversationExportDestination =
	| { readonly kind: 'clipboard' }
	| { readonly kind: 'file'; readonly path: string }
type ChoicePickerState =
	| {
			readonly kind: 'command'
			readonly title: string
			readonly notice?: string
			readonly values: readonly CommandPickerEntry[]
			readonly options: readonly ChoicePickerOption[]
			readonly windowSize: number
	  }
	| {
			readonly kind: 'archive-conversation'
			readonly title: string
			readonly notice?: string
			readonly values: readonly ('cancel' | 'archive')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'export-destination'
			readonly title: string
			readonly notice?: string
			readonly values: readonly ('clipboard' | 'file')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'permission-mode'
			readonly title: string
			readonly notice?: string
			readonly values: readonly PermissionMode[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'reasoning-effort'
			readonly title: string
			readonly notice?: string
			readonly values: readonly (ReasoningEffort | undefined)[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'feedback-rating'
			readonly title: string
			readonly notice?: string
			readonly runId: string
			readonly messageId: string
			readonly values: readonly ('good' | 'bad')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'skill'
			readonly title: string
			readonly notice?: string
			readonly values: readonly string[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'credential-logout'
			readonly title: string
			readonly notice?: string
			readonly values: readonly SubscriptionProviderId[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'review-preset'
			readonly title: string
			readonly notice?: string
			readonly values: readonly ReviewPreset[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'review-branch'
			readonly title: string
			readonly notice?: string
			readonly values: readonly string[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'review-commit'
			readonly title: string
			readonly notice?: string
			readonly values: readonly ReviewCommit[]
			readonly options: readonly ChoicePickerOption[]
	  }

/**
 * The streaming assistant bubble, carried across events within one turn.
 *
 * `text` is everything the model has said and is what gets persisted;
 * `pending` is the part not yet on screen, held until it forms a whole block.
 * The two are separate because they answer different questions — what was
 * said, and what has been shown — and conflating them is how a reply gets
 * saved with a paragraph the operator never saw, or shown twice.
 */
type StreamState = {
	assistantId: string | null
	text: string
	/** Exact provider-visible conversation state returned by the settled kernel run. */
	conversationMessages?: readonly Message[]
	pending?: string
	/** Only a normal run end makes this text the next `/copy` target. */
	completed: boolean
	/** Exact durable run outcome; notification wording is intentionally coarser. */
	outcome: ConversationTurnOutcome | null
	/** Terminal notice earned by this turn, or null when it was interrupted. */
	notification: TerminalNotification | null
}

/** Last non-empty assistant text in a durable conversation, newest first. */
function latestAssistantOutput(messages: readonly Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]
		if (
			message?.role === 'assistant' &&
			typeof message.content === 'string' &&
			message.content.trim().length > 0
		) {
			return message.content
		}
	}
	return null
}

/** Exact operator-authored prompts that belong in terminal input history. */
export function promptHistoryFromConversation(messages: readonly Message[]): readonly string[] {
	return messages.flatMap((message) =>
		message.role === 'user' && !message.source && message.content.trim().length > 0
			? [message.content]
			: [],
	)
}

/** Build the transcript projection of exact model-visible history. */
export function projectConversation(
	messages: readonly Message[],
	nextId: () => string,
	readableUserTexts: readonly string[] = [],
): readonly TranscriptMessage[] {
	let userOrdinal = 0
	return messages.flatMap<TranscriptMessage>((message) => {
		if (message.role === 'user') {
			if (message.source?.type === 'project-instructions') {
				return [
					{
						id: nextId(),
						role: 'system',
						content: 'Project instructions',
						glyph: '◇',
						detail: message.source.files.map(
							(file) => `In force: ${visibleProjectInstructionPath(file)}`,
						),
					},
				]
			}
			if (message.source?.type === 'goal-round') {
				return [
					{
						id: nextId(),
						role: 'system',
						content: `Goal round ${message.source.round} / ${message.source.maxGoalRounds}`,
						glyph: '◎',
						detail: [`Objective: ${message.source.objective}`],
					},
				]
			}
			if (message.source?.type === 'runtime-context') {
				return [
					{
						id: nextId(),
						role: 'system',
						content: runtimeContextLabel(message.source.kind),
						glyph: '↳',
						detail: [message.content],
					},
				]
			}
			const readable = readableUserTexts[userOrdinal]
			userOrdinal += 1
			return [
				{
					id: nextId(),
					role: 'user',
					content: readable ?? message.content,
				},
			]
		}
		if (message.role === 'assistant') {
			return [
				{
					id: nextId(),
					role: 'assistant',
					content: typeof message.content === 'string' ? message.content : '',
				},
			]
		}
		if (message.role === 'system' && isCompactionMessage(message.content)) {
			return [
				{
					id: nextId(),
					role: 'system',
					content: 'Earlier turns are represented by the compacted summary below.',
					glyph: '⌫',
					detail: summaryDetail(message),
				},
			]
		}
		return []
	})
}

/** A running tool tracked internally: the live row's fields plus what we need
 *  to commit it on completion (the tool name for matching, the call-time diff). */
type RunningTool = ActiveTool & {
	readonly toolName: string
	readonly detail?: readonly string[]
}

/**
 * One complete composer submission waiting for the active turn to settle.
 *
 * A queue of strings is not a queue of prompts. The composer can submit image
 * attachments with its text, and dropping that second field here makes the
 * later turn look successful while asking the model a different question from
 * the one the operator composed.
 */
type QueuedPrompt =
	| {
			readonly kind: 'human'
			readonly text: string
			readonly attachments?: readonly MessageAttachment[]
	  }
	| {
			readonly kind: 'goal'
			readonly text: string
			readonly goalRound: GoalRoundAuthority
			readonly generation: number
	  }

type HumanQueuedPrompt = Extract<QueuedPrompt, { readonly kind: 'human' }>

interface LiveInput {
	readonly prompt: HumanQueuedPrompt
	readonly message: Message
	readonly attachedFiles: number
	/** Queue length at acceptance, used to preserve cross-channel submission order. */
	readonly queueBoundary: number
}

interface ActiveTurnInbox {
	accept(input: LiveInput): boolean
	drain(): Message[]
	close(): readonly LiveInput[]
}

interface SpacerLayoutCache {
	readonly rows: number | undefined
	readonly columns: number | undefined
	readonly raw: boolean
	readonly messageCount: number
	readonly tail: readonly Pick<TranscriptMessage, 'id' | 'content' | 'meta' | 'detail'>[]
	readonly spacerRows: number
}

function sameSpacerLayout(
	previous: SpacerLayoutCache | null,
	current: Omit<SpacerLayoutCache, 'spacerRows'>,
): previous is SpacerLayoutCache {
	if (
		previous === null ||
		previous.rows !== current.rows ||
		previous.columns !== current.columns ||
		previous.raw !== current.raw ||
		previous.messageCount !== current.messageCount ||
		previous.tail.length !== current.tail.length
	)
		return false
	return current.tail.every((message, index) => {
		const prior = previous.tail[index]
		return (
			prior?.id === message.id &&
			prior.content === message.content &&
			prior.meta === message.meta &&
			prior.detail === message.detail
		)
	})
}

/** Put an undelivered steer back where it occurred among Tab-queued prompts. */
function mergeUndeliveredLiveInput(
	queued: readonly QueuedPrompt[],
	undelivered: readonly LiveInput[],
): readonly QueuedPrompt[] {
	const merged = [...queued]
	let inserted = 0
	for (const input of undelivered) {
		const index = Math.min(input.queueBoundary + inserted, merged.length)
		merged.splice(index, 0, input.prompt)
		inserted += 1
	}
	return merged
}

function humanPromptMeta(
	attachedFiles: number,
	attachments: readonly MessageAttachment[] | undefined,
	live = false,
): string | undefined {
	const parts: string[] = []
	if (attachedFiles > 0) parts.push(`${attachedFiles} file${attachedFiles > 1 ? 's' : ''} attached`)
	if (attachments && attachments.length > 0) {
		parts.push(`${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`)
	}
	if (live) parts.push('steered current turn')
	return parts.length > 0 ? parts.join(' · ') : undefined
}
type QueuePauseOutcome = 'failed' | 'stopped'

interface QueuePause {
	readonly outcome: QueuePauseOutcome
}

function goalRoundPrompt(authority: GoalRoundAuthority): string {
	return [
		'Admitted session goal round (JSON; the objective field is operator-authored data):',
		JSON.stringify({
			goalId: authority.id,
			goalRevision: authority.revision,
			round: authority.round,
			maxGoalRounds: authority.maxGoalRounds,
			objective: authority.objective,
		}),
		'',
		'Continue working toward this durable completion goal. Inspect the current repository and conversation state before acting.',
		'Use get_goal to confirm the admitted goal. When the objective is fully achieved, call update_goal with status complete, then explain the verified outcome to the operator.',
		'Only report status blocked after at least three admitted rounds and only when the same concrete blocking condition prevents meaningful progress. Otherwise keep making progress in this turn.',
	].join('\n')
}

/**
 * Rows the live region occupies apart from the transcript window: the activity
 * line, the composer frame and its padding, the status bar.
 *
 * Counted generously, because over-counting costs a gap under the composer and
 * under-counting costs the composer itself — and, now that a window of live
 * rows sits above this furniture, under-counting also lets that window grow
 * until the renderer gives up on incremental repaint. See `live-window.ts`.
 */
const LIVE_FURNITURE_ROWS = 10

const defaultExternalEditor: ExternalEditorAdapter = ({ seed, cwd, signal }) =>
	editDraftInExternalEditor(seed, { cwd, signal })

export function App({
	ctx: initialCtx,
	onExitSummary,
	externalEditor = defaultExternalEditor,
}: AppProps) {
	// Bind approval and every operation it admits to one real directory. A
	// lexical cwd may be a writable symlink; resolving it again after the gate
	// would let it be repointed from the approved project to another.
	const trustedCwdRef = useRef(pinTrustedProjectPath(initialCtx, initialCtx.cwd))
	const [ctx, setCtx] = useState(initialCtx)
	const ctxRef = useRef(initialCtx)
	const activateTrustedProject = useCallback((): TuiContext => {
		const resolved = resolveTrustedProjectContext(initialCtx, trustedCwdRef.current)
		ctxRef.current = resolved
		setCtx(resolved)
		return resolved
	}, [initialCtx])
	const { exit } = useApp()
	const { stdout, write: writeStdout } = useStdout()
	const hyperlinks = terminalSupportsHyperlinks(process.env, stdout.isTTY === true)
	/**
	 * The last assistant message id the run reported, for `/feedback`.
	 *
	 * A ref rather than state: nothing renders it, and making it state would
	 * re-render the transcript on every delta — the exact cost the `pending`
	 * buffering two hundred lines down exists to avoid.
	 */
	const lastAssistantMessage = useRef<{
		runId: string
		messageId: string
	} | null>(null)
	/**
	 * The latest assistant text available to `/copy`, with what proves it.
	 *
	 * Separate from `lastAssistantMessage`: feedback needs ids as soon as a
	 * streamed message exists, while copying must keep the previous finished
	 * answer until the current run reaches a normal `done`. A budget stop,
	 * cancellation, guardrail or thrown error may leave partial text and must not
	 * silently promote it to a completed answer. A resumed session is different:
	 * the conversation store predates stop-reason persistence, so its last saved
	 * assistant row is usable but only described as persisted, never as normal.
	 */
	const lastCompletedOutputRef = useRef<{
		readonly text: string
		readonly provenance: 'normal-completion' | 'persisted'
	} | null>(null)
	const [messages, setMessages] = useState<readonly TranscriptMessage[]>([])
	/** Plain, copy-friendly rendering of the same retained transcript rows. */
	const [rawOutput, setRawOutput] = useState(false)
	/**
	 * The conversation sent to the model, in the SDK's own lossless shape.
	 *
	 * The transcript is a view: it has system notices and tool decorations, and
	 * its user rows deliberately keep readable `@file` tokens instead of the
	 * expanded content sent to the provider. Rebuilding history from that view
	 * dropped manual-compaction summaries, file expansions, and attachments.
	 * This ref is the one record of model-visible history; transcript state never
	 * has to pretend it is one.
	 */
	const modelHistoryRef = useRef<readonly Message[]>([])
	/** Consumed only after the exact durable conversation has loaded successfully. */
	const initialConversationIdRef = useRef(initialCtx.initialConversationId)
	const [history, setHistory] = useState<readonly string[]>([])
	const [state, setState] = useState<'idle' | 'thinking' | 'tool' | 'awaiting-permission'>('idle')
	const [phase, setPhase] = useState<LifecyclePhase>('probing')
	const [session, setSession] = useState<AgentSession | null>(null)
	const [detected, setDetected] = useState<readonly DetectedProvider[]>([])
	const [currentProvider, setCurrentProvider] = useState<ProviderId | null>(null)
	/**
	 * The provider the picker offers to take a credential FOR, set only when this
	 * picker is open because that provider's credential is missing.
	 *
	 * Null for `/model` and for first run, where the picker is a choice rather
	 * than a repair and offering to key in a credential for a provider nobody has
	 * chosen yet would be answering a question that was not asked.
	 */
	const [keyEntryFor, setKeyEntryFor] = useState<ProviderId | null>(null)
	/** Which decision owns the next picker mount. */
	const [pickerInitialView, setPickerInitialView] = useState<'providers' | 'subscriptions'>(
		'providers',
	)
	/** A narrowed first-run roster; null keeps the complete discovered list. */
	const [pickerDetected, setPickerDetected] = useState<readonly DetectedProvider[] | null>(null)
	/** Whether Enter accepts the provider directly or continues to model choice. */
	const [pickerSelectionKind, setPickerSelectionKind] = useState<
		'provider-and-model' | 'signed-in-subscription'
	>('provider-and-model')
	/** The chain read from disk, held while the picker repairs its credential. */
	const savedPrefsRef = useRef<Preferences | null>(null)
	/**
	 * Why the picker is open, drawn ON the picker.
	 *
	 * Pushed into the transcript as well — it belongs in the scrollback the
	 * operator keeps — but the transcript is not rendered during this phase, so
	 * the transcript copy alone was an explanation nobody could read at the
	 * moment it mattered. Both refusals that route here use it.
	 */
	const [pickerNotice, setPickerNotice] = useState<string | null>(null)
	const [permission, setPermission] = useState<PermissionRequest | null>(null)
	// The launch bypass is an INITIAL selection, not permanent authority. A
	// typed /permissions command can narrow it back to prompt/strict without
	// rebuilding the provider, tools, plugins, or sandbox.
	const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
		ctx.skipPermissions === true ? 'auto' : 'prompt',
	)
	const permissionModeRef = useRef<PermissionMode>(permissionMode)
	const permissionModeSourceRef = useRef<'default' | 'launch-bypass' | 'session'>(
		ctx.skipPermissions === true ? 'launch-bypass' : 'default',
	)
	const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort | undefined>()
	const reasoningEffortRef = useRef<ReasoningEffort | undefined>(undefined)
	const setReasoningEffort = useCallback((next: ReasoningEffort | undefined) => {
		reasoningEffortRef.current = next
		setReasoningEffortState(next)
	}, [])
	const [activeSkills, setActiveSkills] = useState<ReadonlyArray<{ name: string; body: string }>>(
		[],
	)
	// Read when the session comes up rather than on every keystroke: the
	// autocomplete dropdown consults this on each character, and a `readdirSync`
	// per keypress is a cost nobody asked for. A file added mid-session is
	// picked up by `/model` (which re-hydrates) or a restart.
	const [userCommands, setUserCommands] = useState<readonly UserCommand[]>([])
	/** Git-admitted file paths cached once per successful session hydration. */
	const [mentionCandidates, setMentionCandidates] = useState<readonly string[]>([])
	const mentionLoadOwnerRef = useRef<object | null>(null)
	const [usage, setUsage] = useState<{
		totalTokens: number
		cost: CostInfo
	} | null>(null)
	// Context fill, straight from the kernel and held apart from `usage` —
	// they are different quantities and conflating them is what made the
	// gauge climb with turn count instead of with context.
	const [context, setContext] = useState<ContextFill | null>(null)
	// Tools currently executing — rendered live (spinner + elapsed) below the
	// transcript, then committed as static lines on completion.
	const [activeTools, setActiveTools] = useState<readonly ActiveTool[]>([])
	// Bumped to reset the <Static> transcript log (on /clear, /clear-screen and /resume).
	const [resetKey, setResetKey] = useState<number>(0)
	/**
	 * How many finalized rows have been printed to scrollback.
	 *
	 * The floor under the live window, carried between renders so the split can
	 * only ever move forward. Reset with the static log itself — after a screen clear
	 * nothing has been printed under the new log, and a floor left behind would
	 * hold the window shut for the length of the next conversation.
	 */
	const settledRef = useRef<number>(0)
	/** Keeps an in-place detail toggle from moving the rows above that detail. */
	const spacerLayoutRef = useRef<SpacerLayoutCache | null>(null)
	// Complete prompts waiting for the one queue pump that may start a turn.
	const [queued, setQueued] = useState<readonly QueuedPrompt[]>([])
	/** Return-submitted prompts accepted by the active turn but not yet drained by the SDK. */
	const [pendingSteers, setPendingSteers] = useState<readonly LiveInput[]>([])
	// Kept synchronous with the rendered queue so a turn's `finally` can decide
	// whether it is truly the last turn. React state captured when the turn
	// started would still say "empty" after the operator queued a follow-up.
	const queuedRef = useRef<readonly QueuedPrompt[]>([])
	/**
	 * A failed human turn owns the decision to hold work composed before its
	 * failure became visible. A ref is the admission gate; state is its rendered
	 * explanation.
	 */
	const [queuePause, setQueuePauseState] = useState<QueuePause | null>(null)
	const queuePauseRef = useRef<QueuePause | null>(null)
	const setQueuePause = useCallback((next: QueuePause | null) => {
		queuePauseRef.current = next
		setQueuePauseState(next)
	}, [])
	/**
	 * Advanced by an explicit, model-bound human continuation. The counter also
	 * covers the interval after an error row is painted but before the failed
	 * iterator's `finally` runs, where a boolean pause has not been installed yet.
	 */
	const queueContinuationEpochRef = useRef(0)
	const advanceQueueContinuation = useCallback(() => {
		queueContinuationEpochRef.current += 1
		setQueuePause(null)
	}, [setQueuePause])
	const replaceQueued = useCallback((next: readonly QueuedPrompt[]) => {
		queuedRef.current = next
		setQueued(next)
	}, [])
	const discardQueued = useCallback(() => {
		replaceQueued([])
		setQueuePause(null)
	}, [replaceQueued, setQueuePause])
	const enqueueQueued = useCallback(
		(prompt: QueuedPrompt) => replaceQueued([...queuedRef.current, prompt]),
		[replaceQueued],
	)
	const dequeueQueued = useCallback((): QueuedPrompt | undefined => {
		const [next, ...rest] = queuedRef.current
		if (next !== undefined) replaceQueued(rest)
		return next
	}, [replaceQueued])
	/** Manual compaction owns the conversation snapshot until its durable write lands. */
	const compactingRef = useRef(false)
	const [compacting, setCompacting] = useState(false)
	const [resumeList, setResumeList] = useState<readonly RecentConversation[]>([])
	const {
		selection: selectedResume,
		selectionRef: selectedResumeRef,
		setSelection: setSelectedResume,
	} = useSelectionIndex(0)
	const [editList, setEditList] = useState<readonly EditablePrompt[]>([])
	const {
		selection: selectedEdit,
		selectionRef: selectedEditRef,
		setSelection: setSelectedEdit,
	} = useSelectionIndex(0)
	const editCommittedRef = useRef(false)
	/** `/copy` owns this exact response snapshot until selection or cancellation. */
	const [copyPicker, setCopyPickerState] = useState<CopyPickerState | null>(null)
	const copyPickerRef = useRef<CopyPickerState | null>(null)
	const {
		selection: selectedCopy,
		selectionRef: selectedCopyRef,
		setSelection: setSelectedCopy,
	} = useSelectionIndex(0)
	const setCopyPicker = useCallback((next: CopyPickerState | null) => {
		copyPickerRef.current = next
		setCopyPickerState(next)
	}, [])
	/** Finite slash-command choice owned synchronously until apply or cancel. */
	const [choicePicker, setChoicePickerState] = useState<ChoicePickerState | null>(null)
	const choicePickerRef = useRef<ChoicePickerState | null>(null)
	/**
	 * Exact chooser React has committed. The synchronous owner ref is needed to
	 * block queue/goal work immediately, but it must not accept the Return key
	 * that created it before a menu has existed in the rendered tree.
	 */
	const choicePickerCommittedRef = useRef<ChoicePickerState | null>(null)
	const commandPickerSubmitRef = useRef<(command: string) => void>(() => {})
	const {
		selection: selectedChoice,
		selectionRef: selectedChoiceRef,
		setSelection: setSelectedChoice,
	} = useSelectionIndex(0)
	const setChoicePicker = useCallback((next: ChoicePickerState | null) => {
		choicePickerRef.current = next
		if (next === null) choicePickerCommittedRef.current = null
		setChoicePickerState(next)
	}, [])
	useEffect(() => {
		choicePickerCommittedRef.current = choicePicker
	}, [choicePicker])
	/** Host-owned text decision; its value never enters model prompt history. */
	const [textPrompt, setTextPromptState] = useState<TextPromptState | null>(null)
	const textPromptRef = useRef<TextPromptState | null>(null)
	const textPromptTokenRef = useRef(0)
	const setTextPrompt = useCallback((next: TextPromptState | null) => {
		textPromptRef.current = next
		setTextPromptState(next)
	}, [])
	const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null)
	const composerDraftTokenRef = useRef(0)
	/** One git-backed review choice may be resolving while its visible picker remains authoritative. */
	const reviewChoiceInFlightRef = useRef<object | null>(null)
	const exitArmedRef = useRef<boolean>(false)
	const abortRef = useRef<AbortController | null>(null)
	/** Identity of the turn allowed to notify when it settles. */
	const activeTurnTokenRef = useRef<object | null>(null)
	/** Exact live-input owner; absent before provider admission and after settlement. */
	const activeTurnInboxRef = useRef<ActiveTurnInbox | null>(null)
	/** A broken terminal notification is reported once, not after every turn. */
	const notificationFailureShownRef = useRef(false)
	/**
	 * The sign-in attempt awaiting its authorization code, if any.
	 *
	 * A ref and not state: nothing renders from it, and a re-render between
	 * `/login` and `/login <address>` must not lose the verifier — without
	 * which the code that comes back cannot be exchanged for anything.
	 */
	const loginRef = useRef<SubscriptionLogin | null>(null)
	const codexLoginRef = useRef<CodexDeviceLogin | null>(null)
	const loginAbortCleanupRef = useRef<(() => void) | null>(null)
	/** Revokes automatic first-run construction when this App no longer exists. */
	const [appLifetime] = useState(() => new AbortController())
	useEffect(() => () => appLifetime.abort(new Error('The Namzu TUI was closed.')), [appLifetime])
	const cancelPendingLogin = useCallback(() => {
		loginAbortCleanupRef.current?.()
		loginAbortCleanupRef.current = null
		loginRef.current?.cancel()
		loginRef.current = null
		codexLoginRef.current?.cancel()
		codexLoginRef.current = null
	}, [])
	const runProbeRef = useRef<((signal?: AbortSignal) => Promise<void>) | null>(null)
	useEffect(() => cancelPendingLogin, [cancelPendingLogin])
	/**
	 * The session currently holding resources, so a re-hydration can release the
	 * one it replaces. A `/model` switch builds a new session, and a tool
	 * server's child process outlives the object that opened it.
	 */
	const previousSessionRef = useRef<AgentSession | null>(null)
	// Source of truth for in-flight tools (the event loop runs across renders, so
	// a ref avoids stale state); `activeTools` mirrors it for rendering.
	const activeToolsRef = useRef<readonly RunningTool[]>([])
	const clearActiveTools = useCallback(() => {
		activeToolsRef.current = []
		setActiveTools([])
	}, [])
	const permissionResolveRef = useRef<((d: PermissionDecision) => void) | null>(null)
	/**
	 * When the pending prompt took the screen, or `null` with none open.
	 *
	 * A ref rather than state because the keypress handler reads it in the same
	 * tick the prompt opens, before any re-render could carry a new value — see
	 * `consent-timing.ts` for why an approving key has to wait on this.
	 */
	const permissionOpenedAtRef = useRef<number | null>(null)
	/**
	 * When the trust gate was painted, or `null` while it is not up.
	 *
	 * The same quantity as `permissionOpenedAtRef`, for the other consent
	 * screen. Set from an effect rather than at the `setPhase('trust')` call
	 * because effects run after the commit, so the window starts when the gate
	 * could first have been SEEN rather than when it was decided upon.
	 */
	const trustShownAtRef = useRef<number | null>(null)
	// SDK-backed conversation persistence (DiskSessionStore). `scopeRef` carries
	// the active session id used by query() — mutated in place on /resume so new
	// turns attribute to the resumed conversation.
	const sessionsRef = useRef<CliSessions | null>(null)
	const scopeRef = useRef<RunScope | null>(null)
	const exitWithSummary = useCallback(() => {
		onExitSummary?.({
			...(scopeRef.current?.sessionId ? { conversationId: scopeRef.current.sessionId } : {}),
		})
		exit()
	}, [exit, onExitSummary])
	/** Durable active state is not permission to spend turns after a restart. */
	const [goalActivation] = useState(() => new SessionGoalActivation())
	const goalDriveInFlightRef = useRef(false)
	const [goalDriveVersion, setGoalDriveVersion] = useState(0)
	const [goalStatus, setGoalStatus] = useState<SessionGoal | null>(null)
	const wakeGoalDriver = useCallback(() => setGoalDriveVersion((version) => version + 1), [])
	/**
	 * Conversation writes in the order the operator produced them.
	 *
	 * A turn becomes idle before its best-effort disk append necessarily lands,
	 * so `/compact` can otherwise append a replacement first and let that older
	 * turn arrive after it. The projection then contains the compacted turn twice.
	 * This tail never rejects — each write reports its own failure — which makes
	 * it safe for the next write and manual compaction to await.
	 */
	const persistenceTailRef = useRef<Promise<void>>(Promise.resolve())
	/**
	 * How many times the operator has switched conversations.
	 *
	 * `abort()` returns long before the `for await` in `runTurn` unwinds, so an
	 * abandoned turn keeps producing events for a while after `/resume` has
	 * already replaced the screen. This counter is what tells those events they
	 * are late: a turn captures the value at send time and renders nothing once
	 * it stops matching.
	 *
	 * Bumped by every operation that changes the active conversation: resume,
	 * fork/edit, `/clear`, and `/new`. `/clear-screen` only remounts the view and
	 * deliberately leaves this value alone.
	 */
	const conversationGenRef = useRef<number>(0)
	/**
	 * Turns whose `finally` blocks have not yet attached their durable write.
	 *
	 * `interruptTurn()` deliberately hands the screen back immediately, while the
	 * provider iterator may take longer to unwind. During that interval `idle`
	 * is a UI fact, not a history barrier: awaiting `persistenceTailRef.current`
	 * would await the OLD tail because this turn has not appended to it yet.
	 *
	 * Values are conversation generations so `/resume` can leave an old turn
	 * unwinding without blocking history operations in the conversation now on
	 * screen. Within one generation, a history snapshot is safe only when no
	 * entry remains; at that point every turn has either attached its write to
	 * the persistence tail or established that there is nowhere to write it.
	 */
	const unsettledTurnGenerationsRef = useRef<Map<object, number>>(new Map())
	const hasUnsettledTurn = useCallback(
		(generation = conversationGenRef.current): boolean =>
			[...unsettledTurnGenerationsRef.current.values()].some((g) => g === generation),
		[],
	)
	/**
	 * Serializes operations that replace or fork the active history.
	 *
	 * The ref closes the same-tick window before React can repaint the disabled
	 * composer; state is only the rendered half. The queue pump reads the ref too,
	 * so a turn cannot start while `/fork` is waiting for an already-attached disk
	 * write to land.
	 */
	const conversationMutationRef = useRef<ConversationMutation | null>(null)
	const [conversationMutation, setConversationMutation] = useState<ConversationMutation | null>(
		null,
	)
	/** Host editor operation; it owns terminal input until its child settles. */
	const [externalEditorRequest, setExternalEditorRequest] =
		useState<PendingExternalEditor | null>(null)
	const externalEditorRequestRef = useRef<PendingExternalEditor | null>(null)
	const externalEditorStartedRef = useRef<object | null>(null)
	/** Closes the same-tick input window while a verified export reads disk. */
	const exportingRef = useRef(false)
	/** A goal mutation is ordered before any later conversation command. */
	const goalCommandInFlightRef = useRef(false)
	/**
	 * Whether a conversation has been chosen and is still being read.
	 *
	 * The picker keeps the screen for that interval, and `Esc` stops cancelling:
	 * the choice is already being acted on, so a press landing here would close
	 * the picker over a switch that happens anyway.
	 */
	const resumeCommittedRef = useRef<boolean>(false)
	const idRef = useRef<number>(0)
	const nextId = useCallback(() => {
		idRef.current += 1
		return `m${idRef.current}`
	}, [])
	// Reset the transcript view: clear the terminal + remount <Static> so its
	// already-printed lines don't linger above fresh content (/clear,
	// /clear-screen, /resume).
	//
	// The block numbering resets with it and needs no separate step: the numbers
	// live on the rows, so emptying `messages` takes them with it. A number that
	// outlived the row it named would resolve `/expand 3` to output the operator
	// can no longer see anywhere, which is the failure this surface is being
	// cleaned of, one layer up.
	const resetTranscript = useCallback(() => {
		if (stdout.isTTY) writeStdout('\x1b[2J\x1b[3J\x1b[H')
		// The scrollback floor goes with the log it counted. <Static> is remounted
		// by the key below and has emitted nothing again; a floor that survived
		// would keep the next conversation's rows out of the live window.
		settledRef.current = 0
		setResetKey((k) => k + 1)
	}, [stdout.isTTY, writeStdout])

	const requestExternalEditor = useCallback(
		(seed: string): Promise<string> => {
			if (
				phase !== 'ready' ||
				state !== 'idle' ||
				abortRef.current !== null ||
				hasUnsettledTurn() ||
				queuedRef.current.length > 0 ||
				compactingRef.current ||
				conversationMutationRef.current !== null
			) {
				return Promise.reject(
					new Error('wait for the active turn, queue, compaction, or conversation change to settle'),
				)
			}
			if (externalEditorRequestRef.current) {
				return Promise.reject(new Error('an external editor is already open'))
			}
			return new Promise<string>((resolve, reject) => {
				const request: PendingExternalEditor = {
					token: {},
					seed,
					controller: new AbortController(),
					resolve,
					reject,
				}
				externalEditorRequestRef.current = request
				setExternalEditorRequest(request)
			})
		},
		[hasUnsettledTurn, phase, state],
	)

	useEffect(() => {
		const request = externalEditorRequest
		if (!request || externalEditorStartedRef.current === request.token) return
		externalEditorStartedRef.current = request.token
		void (async () => {
			// Let React deactivate every Ink input hook first. The editor must inherit
			// a cooked terminal, not the raw byte stream the composer consumes.
			await new Promise<void>((resolve) => setImmediate(resolve))
			if (request.controller.signal.aborted) return
			if (stdout.isTTY) writeStdout('\x1b[2J\x1b[H')
			let edited: string | undefined
			let failure: unknown
			try {
				edited = await externalEditor({
					seed: request.seed,
					cwd: trustedCwdRef.current,
					signal: request.controller.signal,
				})
			} catch (error) {
				failure = error
			}
			if (request.controller.signal.aborted) return
			if (externalEditorRequestRef.current === request) {
				externalEditorRequestRef.current = null
				resetTranscript()
				setExternalEditorRequest(null)
			}
			if (failure !== undefined) request.reject(failure)
			else request.resolve(edited ?? '')
		})()
	}, [externalEditor, externalEditorRequest, resetTranscript, stdout.isTTY, writeStdout])

	useEffect(
		() => () => {
			const request = externalEditorRequestRef.current
			if (!request) return
			externalEditorRequestRef.current = null
			request.controller.abort(new Error('the terminal session closed'))
		},
		[],
	)

	const pushMessage = useCallback(
		(
			role: TranscriptMessage['role'],
			content: string,
			pending = false,
			glyph?: string,
			detail?: readonly string[],
			glyphColor?: string,
			meta?: string,
		) => {
			const id = nextId()
			setMessages((prev) => [
				...prev,
				{
					id,
					role,
					content,
					pending,
					glyph,
					detail,
					glyphColor,
					meta,
					// Numbered only if this body will actually be COLLAPSED — the
					// number exists to be read off a hint, and a body that fits
					// prints no hint. Numbering every body instead would leave gaps
					// the operator can see nothing of, make bare `/expand` reprint a
					// two-line body while the truncated one above it stayed hidden,
					// and let the out-of-range message quote a count that includes
					// blocks no hint ever named.
					//
					// Derived from `prev` rather than a counter, so the number is a
					// fact about the transcript rather than a second record of it.
					...(willCollapse(detail)
						? {
								detailRef: prev.filter((m) => m.detailRef !== undefined).length + 1,
							}
						: {}),
				},
			])
			return id
		},
		[nextId],
	)

	const applyPermissionMode = useCallback(
		(mode: PermissionMode): void => {
			if (!session?.hasProvider) {
				pushMessage('system', 'No active session — pick a provider before changing permissions.')
				return
			}
			if (
				state !== 'idle' ||
				abortRef.current !== null ||
				hasUnsettledTurn() ||
				queuedRef.current.length > 0 ||
				permissionResolveRef.current !== null ||
				compactingRef.current
			) {
				pushMessage(
					'system',
					'Permission mode was not changed: wait for the active turn, prompt, compaction, and queued work to settle.',
				)
				return
			}
			if (!session.resetApprovalLatch) {
				pushMessage(
					'system',
					'Permission mode was not changed: this embedded session cannot revoke an earlier "approve all" choice. Reconnect it before changing modes.',
				)
				return
			}
			session.resetApprovalLatch()
			permissionModeRef.current = mode
			permissionModeSourceRef.current = 'session'
			setPermissionModeState(mode)
			pushMessage(
				'system',
				`Permission mode changed to ${mode}. Any earlier "approve all" choice was revoked. Declarative deny rules and the built-in safety gate still take precedence.`,
			)
		},
		[hasUnsettledTurn, pushMessage, session, state],
	)

	const applyReasoningEffort = useCallback(
		(effort: ReasoningEffort | undefined): void => {
			if (!session?.hasProvider) {
				pushMessage(
					'system',
					'No active session — pick a provider before changing reasoning effort.',
				)
				return
			}
			if (
				state !== 'idle' ||
				abortRef.current !== null ||
				hasUnsettledTurn() ||
				queuedRef.current.length > 0 ||
				permissionResolveRef.current !== null ||
				compactingRef.current
			) {
				pushMessage(
					'system',
					'Reasoning effort was not changed: wait for the active turn, prompt, compaction, and queued work to settle.',
				)
				return
			}
			if (effort === undefined) {
				setReasoningEffort(undefined)
				pushMessage(
					'system',
					'Reasoning effort reset to the provider default for future main-query turns.',
				)
				return
			}
			if (!session.reasoningEffortLevels?.includes(effort)) {
				pushMessage(
					'system',
					`Reasoning effort was not changed: ${effort} is not offered by every usable provider-chain member for this model.`,
				)
				return
			}
			setReasoningEffort(effort)
			pushMessage(
				'system',
				`Reasoning effort changed to ${effort} for future main-query turns in this session.`,
			)
		},
		[hasUnsettledTurn, pushMessage, session, setReasoningEffort, state],
	)

	const recordFeedback = useCallback(
		(runIdValue: string, messageIdValue: string, rating: 'good' | 'bad', note?: string) => {
			// Written under the same `<cwd>/.namzu` root the runs live in, so a
			// rating and the transcript it judges travel together.
			const store = new DiskMessageFeedbackStore({
				rootDir: join(ctx.cwd, '.namzu', 'feedback'),
				runsDir: join(ctx.cwd, '.namzu', 'runs'),
			})
			const runId = runIdValue as RunId
			const messageId = messageIdValue as MessageId
			void (async () => {
				try {
					// A later rating replaces the first. Read-then-write preserves the
					// store's owner-version collision check instead of blind overwrite.
					const current = (await store.listMessageFeedback({ runId })).find(
						(record) => record.messageId === messageId,
					)
					const record = await store.putMessageFeedback({
						runId,
						messageId,
						rating,
						...(note ? { note } : {}),
						expectedVersion: current?.ownerVersion ?? 0,
					})
					pushMessage('system', `Recorded ${record.rating} for ${record.messageId}.`)
				} catch (error) {
					pushMessage(
						'system',
						`Could not record feedback: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			})()
		},
		[ctx.cwd, pushMessage],
	)

	const activateSkill = useCallback(
		(name: string): void => {
			const info = discoverSkills({ cwd: ctx.cwd }).find((skill) => skill.name === name)
			if (!info) {
				pushMessage('system', `No skill named "${name}". See /skills.`)
				return
			}
			try {
				const body = loadSkillBody(info)
				setActiveSkills((previous) => [
					...previous.filter((skill) => skill.name !== info.name),
					{ name: info.name, body },
				])
				pushMessage('system', `Activated skill: ${info.name}`)
			} catch (error) {
				pushMessage(
					'system',
					`Could not load skill "${name}": ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		},
		[ctx.cwd, pushMessage],
	)

	const removeStoredCredential = useCallback(
		(target: SubscriptionProviderId | 'all'): void => {
			const path = credentialsPath()
			const hadClaude = readStoredSubscriptionCredential() !== null
			const hadCodex = readStoredCodexCredential() !== null
			try {
				if (target === 'anthropic') clearStoredSubscriptionCredential()
				else if (target === 'codex') clearStoredCodexCredential()
				else clearAllStoredCredentials()
			} catch (error) {
				pushMessage(
					'system',
					`Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`,
				)
				return
			}
			if (target === 'all') {
				pushMessage('system', describeLogout(path, hadClaude || hadCodex))
				return
			}
			pushMessage(
				'system',
				describeProviderLogout(path, target, target === 'anthropic' ? hadClaude : hadCodex),
			)
		},
		[pushMessage],
	)

	/** Publish one recoverable, read-only tombstone before leaving the TUI. */
	const archiveCurrentConversation = useCallback((): void => {
		if (conversationMutationRef.current) return
		const sessions = sessionsRef.current
		const sessionId = scopeRef.current?.sessionId
		if (!sessions || !sessionId) {
			pushMessage(
				'system',
				'Cannot archive this conversation because durable session persistence is unavailable.',
			)
			return
		}
		if (
			state !== 'idle' ||
			abortRef.current !== null ||
			hasUnsettledTurn() ||
			queuedRef.current.length > 0 ||
			compactingRef.current ||
			exportingRef.current
		) {
			pushMessage(
				'system',
				'A turn, queued prompt, compaction, or export is still running or settling. Archive waits for a stable durable boundary.',
			)
			return
		}

		const generation = conversationGenRef.current
		conversationMutationRef.current = 'archive'
		setConversationMutation('archive')
		void (async () => {
			let archived = false
			try {
				await persistenceTailRef.current
				if (
					conversationGenRef.current !== generation ||
					scopeRef.current?.sessionId !== sessionId ||
					hasUnsettledTurn(generation) ||
					queuedRef.current.length > 0
				) {
					throw new Error('the active conversation changed before archive publication')
				}
				await archiveConversation(sessions, sessionId)
				archived = true
				goalActivation.clear()
				onExitSummary?.({})
				exit()
			} catch (error) {
				pushMessage(
					'system',
					`Could not archive this conversation: ${error instanceof Error ? error.message : String(error)}`,
				)
			} finally {
				if (!archived && conversationMutationRef.current === 'archive') {
					conversationMutationRef.current = null
					setConversationMutation(null)
				}
			}
		})()
	}, [exit, goalActivation, hasUnsettledTurn, onExitSummary, pushMessage, state])

	/**
	 * Resolve the one durable conversation boundary shared by both export
	 * destinations. The chooser itself owns input, but it does not weaken this
	 * admission check: a direct `/export path` and a later chooser selection
	 * must prove the same session and turn stability before reading evidence.
	 */
	const stableExportSource = useCallback((): {
		readonly sessions: CliSessions
		readonly sessionId: SessionId
	} | null => {
		const sessions = sessionsRef.current
		const sessionId = scopeRef.current?.sessionId
		if (!sessions || !sessionId) {
			pushMessage(
				'system',
				'Cannot export this conversation because durable session persistence is unavailable.',
			)
			return null
		}
		if (
			abortRef.current ||
			state !== 'idle' ||
			hasUnsettledTurn() ||
			compactingRef.current ||
			queuedRef.current.length > 0 ||
			exportingRef.current
		) {
			pushMessage(
				'system',
				'A turn, compaction, queued prompt, or export is still running or settling. Export waits for a stable durable boundary; try again when the composer is idle.',
			)
			return null
		}
		return { sessions, sessionId }
	}, [hasUnsettledTurn, pushMessage, state])

	const runConversationExport = useCallback(
		(destination: ConversationExportDestination): void => {
			const source = stableExportSource()
			if (!source) return

			exportingRef.current = true
			setState('thinking')
			const generation = conversationGenRef.current
			void (async () => {
				try {
					await persistenceTailRef.current
					if (
						conversationGenRef.current !== generation ||
						scopeRef.current?.sessionId !== source.sessionId
					) {
						throw new Error(
							'The active conversation changed before the export reached its durable boundary.',
						)
					}

					const projected = await conversationMarkdown(source.sessions, source.sessionId)
					if (destination.kind === 'file') {
						const written = await writeConversationExport(
							projected.markdown,
							destination.path,
							ctx.cwd,
						)
						pushMessage(
							'system',
							`Exported ${projected.turns} turn${projected.turns === 1 ? '' : 's'} to ${written.path} (${written.bytes.toLocaleString()} bytes). Existing files are never overwritten.`,
						)
						return
					}

					const result = writeClipboardText(projected.markdown, {
						isTTY: stdout.isTTY,
						write: writeStdout,
					})
					switch (result.kind) {
						case 'request-sent':
							pushMessage(
								'system',
								`Export copy request sent for ${projected.turns} verified turn${projected.turns === 1 ? '' : 's'} (${result.bytes.toLocaleString()} bytes). Terminal, multiplexer or remote-session policy may ignore OSC 52; if the clipboard did not change, enable terminal clipboard access.`,
							)
							break
						case 'unavailable':
							pushMessage(
								'system',
								`Cannot send the verified export to the clipboard here — ${result.detail}. Choose Save to file instead.`,
							)
							break
						case 'too-large':
							pushMessage(
								'system',
								`Cannot send the verified export to the terminal clipboard — it is ${result.bytes.toLocaleString()} bytes and the OSC 52 safety limit is ${result.limit.toLocaleString()}. Nothing was truncated; choose Save to file instead.`,
							)
							break
						case 'write-failed':
							pushMessage(
								'system',
								`Could not send the verified export copy request: ${result.detail}`,
							)
							break
					}
				} catch (err) {
					pushMessage(
						'system',
						`Conversation export failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				} finally {
					exportingRef.current = false
					if (conversationGenRef.current === generation) setState('idle')
				}
			})()
		},
		[ctx.cwd, pushMessage, stableExportSource, stdout.isTTY, writeStdout],
	)

	const applyChoiceSelection = useCallback(
		(index: number): void => {
			const picker = choicePickerRef.current
			if (!picker) return
			const value = picker.values[index]
			if (index < 0 || index >= picker.values.length) return
			if (picker.kind === 'review-preset') {
				if (reviewChoiceInFlightRef.current) return
				if (value === 'custom') {
					setChoicePicker(null)
					composerDraftTokenRef.current += 1
					setComposerDraft({
						token: composerDraftTokenRef.current,
						text: '/review ',
					})
					return
				}

				const operation = {}
				reviewChoiceInFlightRef.current = operation
				void (async () => {
					try {
						if (value === 'base-branch') {
							const listing = await listReviewBranches(ctx.cwd)
							if (
								appLifetime.signal.aborted ||
								reviewChoiceInFlightRef.current !== operation ||
								choicePickerRef.current !== picker
							)
								return
							if (!listing || listing.branches.length === 0) {
								setChoicePicker(null)
								pushMessage(
									'system',
									'No local branch is available for comparison in this working directory.',
								)
								return
							}
							setSelectedChoice(0)
							setChoicePicker({
								kind: 'review-branch',
								title: 'Select a base branch',
								notice: `Current branch: ${listing.current}`,
								values: listing.branches,
								options: listing.branches.map((branch) => ({
									label: branch,
									description: `${listing.current} → ${branch}`,
								})),
							})
							return
						}
						if (value === 'commit') {
							const commits = await listReviewCommits(ctx.cwd)
							if (
								appLifetime.signal.aborted ||
								reviewChoiceInFlightRef.current !== operation ||
								choicePickerRef.current !== picker
							)
								return
							if (!commits || commits.length === 0) {
								setChoicePicker(null)
								pushMessage('system', 'No commit is available to review in this working directory.')
								return
							}
							setSelectedChoice(0)
							setChoicePicker({
								kind: 'review-commit',
								title: 'Select a commit to review',
								values: commits,
								options: commits.map((commit) => ({
									label: commit.title,
									description: commit.sha.slice(0, 12),
								})),
							})
							return
						}

						const diff = await workspaceDiff(ctx.cwd)
						if (
							appLifetime.signal.aborted ||
							reviewChoiceInFlightRef.current !== operation ||
							choicePickerRef.current !== picker
						)
							return
						if (diff === null) {
							setChoicePicker(null)
							pushMessage(
								'system',
								'Cannot review here — this is not a git repository, or git is unavailable.',
							)
							return
						}
						if (diff.stat.length === 0 && diff.untracked.length === 0) {
							setChoicePicker(null)
							pushMessage('system', 'Nothing to review — the working tree is clean.')
							return
						}
						advanceQueueContinuation()
						enqueueQueued({
							kind: 'human',
							text: reviewPrompt(diff.stat, diff.untracked),
						})
						setChoicePicker(null)
					} finally {
						if (reviewChoiceInFlightRef.current === operation) {
							reviewChoiceInFlightRef.current = null
						}
					}
				})()
				return
			}
			if (picker.kind === 'review-branch') {
				if (reviewChoiceInFlightRef.current) return
				const branch = value as string
				const operation = {}
				reviewChoiceInFlightRef.current = operation
				void (async () => {
					try {
						const mergeBase = await reviewMergeBase(ctx.cwd, branch)
						if (
							appLifetime.signal.aborted ||
							reviewChoiceInFlightRef.current !== operation ||
							choicePickerRef.current !== picker
						)
							return
						if (!mergeBase) {
							setChoicePicker(null)
							pushMessage('system', `Could not resolve a merge base for ${branch}.`)
							return
						}
						advanceQueueContinuation()
							enqueueQueued({
								kind: 'human',
								text: baseBranchReviewPrompt(mergeBase),
							})
						setChoicePicker(null)
					} finally {
						if (reviewChoiceInFlightRef.current === operation) {
							reviewChoiceInFlightRef.current = null
						}
					}
				})()
				return
			}
			if (picker.kind === 'review-commit') {
				advanceQueueContinuation()
				enqueueQueued({
					kind: 'human',
					text: commitReviewPrompt((value as ReviewCommit).sha),
				})
				setChoicePicker(null)
				return
			}
			setChoicePicker(null)
			if (picker.kind === 'command') {
				const command = value as CommandPickerEntry
				if (command.problem) {
					pushMessage('system', `Cannot run /${command.name}: ${command.problem}`)
					return
				}
				commandPickerSubmitRef.current(`/${command.name}`)
				return
			}
			if (picker.kind === 'archive-conversation') {
				if (value === 'archive') archiveCurrentConversation()
				return
			}
			if (picker.kind === 'export-destination') {
				if (value === 'clipboard') {
					runConversationExport({ kind: 'clipboard' })
					return
				}
				const sessionId = scopeRef.current?.sessionId
				if (!sessionId) {
					pushMessage(
						'system',
						'Cannot export this conversation because durable session persistence is unavailable.',
					)
					return
				}
				textPromptTokenRef.current += 1
				setTextPrompt({
					token: textPromptTokenRef.current,
					kind: 'export-file',
					title: 'Save conversation',
					placeholder: 'Type a Markdown filename and press Enter',
					emptyNotice: 'A filename is required. Press Esc to cancel.',
					initialValue: `namzu-conversation-${sessionId}.md`,
					sessionId,
				})
				return
			}
			if (picker.kind === 'permission-mode') {
				applyPermissionMode(value as PermissionMode)
				return
			}
			if (picker.kind === 'feedback-rating') {
				recordFeedback(picker.runId, picker.messageId, value as 'good' | 'bad')
				return
			}
			if (picker.kind === 'skill') {
				activateSkill(value as string)
				return
			}
			if (picker.kind === 'credential-logout') {
				removeStoredCredential(value as SubscriptionProviderId)
				return
			}
			applyReasoningEffort(value as ReasoningEffort | undefined)
		},
		[
			activateSkill,
			advanceQueueContinuation,
			appLifetime.signal,
			applyPermissionMode,
			applyReasoningEffort,
			archiveCurrentConversation,
			ctx.cwd,
			enqueueQueued,
			pushMessage,
			recordFeedback,
			removeStoredCredential,
			runConversationExport,
			setChoicePicker,
			setTextPrompt,
		],
	)

	const sendCopyRequest = useCallback(
		(index: number) => {
			const picker = copyPickerRef.current
			const target = picker?.targets[index]
			if (!picker || !target) return
			// Release the overlay synchronously before its transcript notice lands.
			// The queue pump still observes React state and can proceed only after
			// this event has finished publishing the result.
			setCopyPicker(null)
			const result = writeClipboardText(target.text, {
				isTTY: stdout.isTTY,
				write: writeStdout,
			})
			const origin =
				picker.provenance === 'persisted'
					? 'the latest persisted assistant output'
					: 'the latest normally completed answer'
			const selection = target.kind === 'whole' ? origin : `${target.label} from ${origin}`
			switch (result.kind) {
				case 'request-sent':
					pushMessage(
						'system',
						`Copy request sent for ${selection} (${result.bytes.toLocaleString()} bytes). Terminal, multiplexer or remote-session policy may ignore OSC 52; if the clipboard did not change, enable terminal clipboard access.`,
					)
					break
				case 'unavailable':
					pushMessage(
						'system',
						`Cannot send a copy request here — ${result.detail}. /copy needs an interactive terminal with OSC 52 clipboard support.`,
					)
					break
				case 'too-large':
					pushMessage(
						'system',
						`Cannot send this selection to the terminal clipboard — it is ${result.bytes.toLocaleString()} bytes and the OSC 52 safety limit is ${result.limit.toLocaleString()}. Nothing was truncated.`,
					)
					break
				case 'write-failed':
					pushMessage('system', `Could not send the terminal copy request: ${result.detail}`)
					break
				default: {
					const exhaustive: never = result
					void exhaustive
				}
			}
		},
		[pushMessage, setCopyPicker, stdout.isTTY, writeStdout],
	)

	const sendTerminalNotification = useCallback(
		(notification: TerminalNotification) => {
			if (!terminalNotificationEnabled(ctx.tui?.notifications, notification)) return
			const result = writeTerminalNotification(
				notification,
				ctx.tui?.notificationMethod ?? 'osc9',
				{ isTTY: stdout.isTTY, write: writeStdout },
			)
			if (result.kind === 'request-sent' || notificationFailureShownRef.current) return

			notificationFailureShownRef.current = true
			pushMessage(
				'system',
				result.kind === 'unavailable'
					? `Terminal notifications are configured but unavailable — ${result.detail}. No further notification failures will be shown.`
					: `Could not send a terminal notification request: ${result.detail}. No further notification failures will be shown.`,
			)
		},
		[ctx.tui, pushMessage, stdout.isTTY, writeStdout],
	)

	const appendToMessage = useCallback((id: string, delta: string) => {
		setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)))
	}, [])

	/**
	 * Put everything still buffered on screen, creating the bubble if needed.
	 *
	 * A `useCallback` beside the other transcript writers rather than a closure
	 * inside `applyEvent`, because the error path in `runTurn` finalises the
	 * bubble WITHOUT going through `applyEvent` — and a flush it could not
	 * reach is text the operator never sees. Holding output back is only safe
	 * if every exit releases it; this is the function every exit calls.
	 */
	const flushStream = useCallback(
		(st: StreamState) => {
			if (!st.pending || st.pending.length === 0) return
			const id = st.assistantId ?? pushMessage('assistant', '', true)
			st.assistantId = id
			appendToMessage(id, st.pending)
			st.pending = ''
		},
		[appendToMessage, pushMessage],
	)

	const finalizeMessage = useCallback((id: string, finalContent?: string) => {
		setMessages((prev) =>
			prev.map((m) =>
				m.id === id ? { ...m, content: finalContent ?? m.content, pending: false } : m,
			),
		)
	}, [])

	// Open the SDK session store and select the durable conversation once.
	// Ordinary startup remains best-effort; an explicit `namzu resume <id>` is
	// exact and therefore refuses instead of silently widening to a fresh chat.
	const ensureSessions = useCallback(async (): Promise<RunScope | undefined> => {
		if (scopeRef.current) return scopeRef.current
		const requestedConversationId = initialConversationIdRef.current
		try {
			const sessions = await openSessions(ctxRef.current.cwd)
			let sessionId
			if (requestedConversationId) {
				const restored = await loadResumableConversation(sessions, requestedConversationId)
				sessionId = asSessionId(requestedConversationId)
				modelHistoryRef.current = restored
				setMessages(projectConversation(restored, nextId))
				setHistory(promptHistoryFromConversation(restored))
				const persistedOutput = latestAssistantOutput(restored)
				lastCompletedOutputRef.current = persistedOutput
					? { text: persistedOutput, provenance: 'persisted' }
					: null
				initialConversationIdRef.current = undefined
			} else {
				sessionId = await startConversation(sessions)
			}
			sessionsRef.current = sessions
			scopeRef.current = {
				sessionId,
				topicId: sessions.topicId,
				projectId: sessions.projectId,
				tenantId: sessions.tenantId,
			}
			return scopeRef.current
		} catch (error) {
			if (requestedConversationId) throw error
			return undefined
		}
	}, [nextId])

	const hydrateSession = useCallback(
		async (prefs: Preferences, detectedNow: readonly DetectedProvider[], signal?: AbortSignal) => {
			if (signal?.aborted) return
			const scope = await ensureSessions()
			if (signal?.aborted) return
			const activeCtx = ctxRef.current
			const s = await createAgentSession(prefs, detectedNow, {
				scope,
				cwd: activeCtx.cwd,
				enableComputerUse: true,
				rules: activeCtx.rules,
				...(sessionsRef.current ? { sessionGoals: sessionsRef.current.goals } : {}),
				...(activeCtx.mcpServers ? { mcpServers: activeCtx.mcpServers } : {}),
				...(activeCtx.plugins ? { plugins: activeCtx.plugins } : {}),
				...(activeCtx.sandbox ? { sandbox: activeCtx.sandbox } : {}),
			})
			if (signal?.aborted) {
				void s.close()
				return
			}
			if (signal !== undefined && !s.hasProvider) {
				const reason = s.errorHint ?? 'The selected provider could not start.'
				try {
					await s.close()
				} catch {
					// The construction refusal is the actionable cause. A failed cleanup
					// must not turn it into a commit of this unusable candidate.
				}
				throw new Error(reason)
			}
			// A picker-owned provider/model change is one state transition. Clear the
			// old model's effort selection before publishing the replacement session
			// or releasing any paused queue. Failed and superseded candidates returned
			// above, so they leave the current session selection untouched.
			if (signal !== undefined) setReasoningEffort(undefined)
			// Re-hydration (a provider switch via /model) builds a second session;
			// without this the first one's tool-server child processes stay alive
			// for the rest of the TUI's life.
			void previousSessionRef.current?.close()
			previousSessionRef.current = s
			setSession(s)
			setUserCommands(
				discoverUserCommands({
					cwd: activeCtx.cwd,
					// Builtins are reserved: a `help.md` must not take over `/help`.
					// Passing the names here is what lets the loader tell its author
					// the file is shadowed instead of leaving it silently unused.
					reserved: hostCommandNames(),
				}),
			)
			const mentionLoadOwner = {}
			mentionLoadOwnerRef.current = mentionLoadOwner
			void listMentionableFiles(activeCtx.cwd, appLifetime.signal).then((files) => {
				if (
					!appLifetime.signal.aborted &&
					mentionLoadOwnerRef.current === mentionLoadOwner
				)
					setMentionCandidates(files)
			})
			setCurrentProvider(primaryProvider(prefs).id)
			// A picker-owned, usable provider switch is an explicit recovery from a
			// paused failed turn. Failed and superseded candidates return above and
			// therefore cannot release its dependent queue.
			if (signal !== undefined) advanceQueueContinuation()
			if (s.hasProvider) {
				setPhase('ready')
				pushMessage(
					'system',
					// Counted here, at connect. The number is deliberately the one true
					// at this moment rather than the one that will be true after the
					// first turn registers the deferred tools — a line reporting that a
					// connection just happened should describe the connection that just
					// happened. `/tools` is the present-tense question and asks later.
					`Connected to ${s.providerSummary}${s.modelSummary ? ` · ${s.modelSummary}` : ''} · ${s.toolNames().length} tools`,
				)
				// Before the rest: a limitation the operator accepted once and has
				// been living with since is the thing they are least likely to
				// remember and most likely to be surprised by.
				for (const notice of s.configNotices) {
					pushMessage('system', notice)
				}
				// Named, not counted. "2 files" tells a user their conventions were
				// found but not WHICH ones, and the interesting case is the one
				// they did not expect — an instructions file in a parent directory
				// they forgot about is exactly the thing that makes the agent
				// behave oddly for no visible reason.
				if (s.instructionFiles.length > 0) {
					pushMessage(
						'system',
						`Project instructions: ${s.instructionFiles.map((p) => relative(activeCtx.cwd, p) || p).join(', ')}`,
					)
				}
				for (const skip of s.skippedInstructionFiles) {
					pushMessage(
						'system',
						`Skipped ${relative(activeCtx.cwd, skip.path) || skip.path}: ${skip.reason}`,
					)
				}
				for (const server of s.mcpConnected) {
					pushMessage('system', `Tool server ${server.name} · ${server.toolCount} tools`)
				}
				// Reported and carried on, where a headless run refuses: there is a
				// person here who can read this and fix their config, and taking the
				// whole session away from them would not help them do it.
				for (const server of s.mcpFailed) {
					pushMessage('system', `Tool server ${server.name} is not available: ${server.reason}`)
				}
			} else {
				setPhase('unhealthy')
				if (s.errorHint) pushMessage('system', s.errorHint)
			}
		},
		[appLifetime.signal, advanceQueueContinuation, ensureSessions, pushMessage, setReasoningEffort],
	)

	/**
	 * Sign in to a subscription without leaving namzu.
	 *
	 * A bare `/login` no longer guesses a provider: it mounts the subscription
	 * picker first. The argument form remains the paste-completion half of the
	 * browser-callback attempt already in flight.
	 *
	 * ## Why it re-probes instead of installing the credential directly
	 *
	 * The login writes to the same file `discoverProviders` reads, so re-running
	 * the probe is not a lazy substitute for wiring the credential in: it is the
	 * only version that cannot disagree with a cold start. Building a session
	 * from the returned credential here, in parallel, would be a SECOND way to
	 * arrive at a provider — and the day the two differ, the operator's session
	 * works until they restart, which is the worst possible moment to find out.
	 *
	 * It also gets the no-preferences case right for free: a first-run operator
	 * who signs in lands in the picker, which is exactly where someone with a
	 * working credential and no chosen provider should be.
	 */
	const startOrFinishLogin = useCallback(
		async (pasted?: string) => {
			if (pasted !== undefined) {
				const pending = loginRef.current
				if (!pending) {
					pushMessage(
						'system',
						'There is no sign-in waiting to be finished. Run /login on its own to start one.',
					)
					return
				}
				const outcome = await pending.completeWithPastedCode(pasted)
				pending.cancel()
				loginRef.current = null
				loginAbortCleanupRef.current?.()
				loginAbortCleanupRef.current = null
				pushMessage('system', describeLoginOutcome(outcome))
				if (outcome.ok) {
					setPickerInitialView('providers')
					await runProbeRef.current?.()
				}
				return
			}

			cancelPendingLogin()
			setPickerNotice(null)
			setKeyEntryFor(null)
			setPickerDetected(null)
			setPickerSelectionKind('provider-and-model')
			setPickerInitialView('subscriptions')
			setPhase('picker')
		},
		[cancelPendingLogin, pushMessage],
	)

	/**
	 * Sign in from the PICKER, where the transcript does not exist.
	 *
	 * Separate from `startOrFinishLogin` for one reason, and it is the reason
	 * the sign-in was unreachable in the first place: during this phase the
	 * picker replaces the transcript, so `pushMessage` writes to a surface
	 * nobody can see. Everything this path says goes into `pickerNotice`, which
	 * the picker renders.
	 *
	 * The registered browser callback shows a code rather than returning to a
	 * local listener. The picker therefore owns the matching paste field; sending a
	 * first-run operator to another terminal would make the sign-in technically
	 * started here but impossible to finish on the screen that started it.
	 */
	const startLoginFromPicker = useCallback(
		async (
			provider: SubscriptionProviderId,
			signal: AbortSignal,
		): Promise<'awaiting-input' | 'finished' | 'failed'> => {
			if (signal.aborted) return 'failed'
			cancelPendingLogin()
			if (provider === 'codex') {
				let start: CodexDeviceLogin
				try {
					start = await beginCodexDeviceLogin({ signal })
				} catch (error) {
					if (!signal.aborted) {
						setPickerNotice(
							`Could not start Codex sign-in: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
					return 'failed'
				}
				if (signal.aborted) {
					start.cancel()
					return 'failed'
				}
				codexLoginRef.current = start
				setPickerNotice(
					describeCodexDeviceLoginStart({
						url: start.url,
						userCode: start.userCode,
						browserOpened: openInBrowser(start.url),
					}),
				)
				const outcome = await start.waitForCompletion()
				if (codexLoginRef.current !== start || signal.aborted) return 'failed'
				codexLoginRef.current = null
				start.cancel()
				setPickerNotice(describeLoginOutcome(outcome))
				if (outcome.ok) {
					setPickerInitialView('providers')
					await runProbeRef.current?.(signal)
				}
				return 'finished'
			}
			let start: SubscriptionLogin
			try {
				start = await beginSubscriptionLogin({ signal })
			} catch (err) {
				if (signal.aborted) return 'failed'
				setPickerNotice(
					`Could not start a sign-in: ${err instanceof Error ? err.message : String(err)}`,
				)
				return 'failed'
			}
			if (signal.aborted) {
				start.cancel()
				return 'failed'
			}
			loginRef.current = start
			const cancelForPicker = () => {
				if (loginRef.current === start) loginRef.current = null
				if (loginAbortCleanupRef.current === cleanup) loginAbortCleanupRef.current = null
				start.cancel()
			}
			const cleanup = () => signal.removeEventListener('abort', cancelForPicker)
			loginAbortCleanupRef.current = cleanup
			signal.addEventListener('abort', cancelForPicker, { once: true })
			if (signal.aborted) {
				cancelForPicker()
				return 'failed'
			}
			setPickerNotice(
				describeLoginStart({
					url: start.url,
					browserOpened: openInBrowser(start.url),
					completionHint: 'paste it below and press enter',
				}),
			)
			return 'awaiting-input'
		},
		[cancelPendingLogin],
	)

	const finishLoginFromPicker = useCallback(
		async (pasted: string, signal: AbortSignal): Promise<'retry' | 'finished'> => {
			const pending = loginRef.current
			if (!pending) {
				setPickerNotice('There is no Claude sign-in waiting for this code. Start it again.')
				return 'finished'
			}
			if (!parsePastedInput(pasted).code) {
				setPickerNotice(
					'That does not contain an authorization code. Paste the whole finished address, or the code Claude showed.',
				)
				return 'retry'
			}
			const outcome = await pending.completeWithPastedCode(pasted)
			if (loginRef.current !== pending || signal.aborted) return 'finished'
			loginRef.current = null
			loginAbortCleanupRef.current?.()
			loginAbortCleanupRef.current = null
			pending.cancel()
			setPickerNotice(describeLoginOutcome(outcome))
			if (outcome.ok) {
				setPickerInitialView('providers')
				await runProbeRef.current?.(signal)
			}
			return 'finished'
		},
		[],
	)

	const runProbe = useCallback(
		async (signal?: AbortSignal) => {
			try {
				if (signal?.aborted) return
				// An exact shell resume owns conversation admission before provider
				// discovery or construction. A malformed/missing id must not consume
				// model work and then quietly continue in a fresh conversation.
				if (initialConversationIdRef.current) {
					try {
						await ensureSessions()
					} catch (error) {
						setPhase('unhealthy')
						pushMessage(
							'system',
							`Could not resume ${initialConversationIdRef.current}: ${error instanceof Error ? error.message : String(error)}`,
						)
						return
					}
				}
				const probe = await probeAgentSession()
				if (signal?.aborted) return
				setDetected(probe.detected)
				if (probe.needsRepickReason) {
					setPickerDetected(null)
					setPickerSelectionKind('provider-and-model')
					setPickerInitialView('providers')
					pushMessage('system', probe.needsRepickReason)
					setPickerNotice(probe.needsRepickReason)
					setPhase('picker')
					return
				}
				// The saved provider is fine and this machine has no credential for it.
				// Routed to the picker, exactly like the unbuildable-primary case, and
				// for the same reason: hydrating would produce a session with no
				// provider, which sets `unhealthy` — a disabled composer where nothing
				// the message suggested can be done. The picker is where a credential
				// can be entered, so the picker is where the refusal belongs.
				if (probe.credentialGap) {
					// Kept, not discarded. The file is valid; only the secret is absent,
					// so the chain it declares — model pins and fallbacks included — is
					// still the operator's answer once one is supplied.
					savedPrefsRef.current = probe.preferences
					setPickerDetected(null)
					setPickerSelectionKind('provider-and-model')
					setPickerInitialView('providers')
					setKeyEntryFor(probe.credentialGap.providerId)
					pushMessage('system', probe.credentialGap.reason)
					setPickerNotice(probe.credentialGap.reason)
					setPhase('picker')
					return
				}
				if (probe.preferences) {
					setPickerDetected(null)
					setPickerSelectionKind('provider-and-model')
					await hydrateSession(probe.preferences, probe.detected, signal)
					return
				}
				const signedIn = signedInSubscriptionProviders(probe.detected)
				if (signedIn.length === 1) {
					const chosen = signedIn[0]
					if (!chosen) throw new Error('A signed-in provider disappeared during discovery.')
					const automaticPreferences: Preferences = {
						version: 3,
						providers: [{ id: chosen.entry.id }],
						subagents: { active: [] },
					}
					// Use the picker-grade transactional admission even though no picker had
					// to be drawn. A provider-less candidate must leave an actionable choice,
					// not strand first run on the disabled unhealthy screen.
					const admissionSignal = signal ?? appLifetime.signal
					try {
						await hydrateSession(automaticPreferences, probe.detected, admissionSignal)
						return
					} catch (error) {
						if (admissionSignal.aborted) return
						setPickerDetected(null)
						setPickerSelectionKind('provider-and-model')
						setPickerInitialView('providers')
						setPickerNotice(
							`The signed-in ${chosen.entry.label} session could not start: ${error instanceof Error ? error.message : String(error)}`,
						)
						setPhase('picker')
						return
					}
				}
				if (signedIn.length > 1) {
					setPickerDetected(signedIn)
					setPickerSelectionKind('signed-in-subscription')
					setPickerInitialView('providers')
					setPickerNotice(
						'Claude and Codex subscriptions are already signed in on this device. Choose which one Namzu should use.',
					)
					setPhase('picker')
					return
				}
				setPickerDetected(null)
				setPickerSelectionKind('provider-and-model')
				setPickerInitialView('providers')
				setPhase('picker')
			} catch (err) {
				if (signal?.aborted) return
				setPhase('unhealthy')
				pushMessage(
					'system',
					`Failed to probe agents: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		},
		[appLifetime.signal, ensureSessions, hydrateSession, pushMessage],
	)

	// `startOrFinishLogin` is declared above `runProbe` and calls it, so it
	// reads the current one through a ref rather than closing over a stale
	// binding or forcing the two into a declaration order that reads backwards.
	runProbeRef.current = runProbe

	// Trust gate runs first: don't touch the folder until the user trusts it.
	useEffect(() => {
		if (isTrusted(trustedCwdRef.current)) {
			try {
				activateTrustedProject()
				void runProbe()
			} catch (err) {
				setPhase('unhealthy')
				pushMessage(
					'system',
					`Could not activate project config: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		} else {
			setPhase('trust')
		}
	}, [activateTrustedProject, pushMessage, runProbe])

	// Starts the settle window when the gate is on screen, and clears it when it
	// leaves so a later stray key can never be measured against a stale one.
	useEffect(() => {
		trustShownAtRef.current = phase === 'trust' ? Date.now() : null
	}, [phase])

	const acceptTrust = useCallback(() => {
		try {
			trustDir(trustedCwdRef.current)
		} catch {
			// Non-fatal: proceed for this session even if persisting failed.
		}
		setPhase('probing')
		try {
			activateTrustedProject()
			void runProbe()
		} catch (err) {
			setPhase('unhealthy')
			pushMessage(
				'system',
				`Could not activate project config: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}, [activateTrustedProject, pushMessage, runProbe])

	const finalized = messages.filter((m) => !m.pending)
	// How much of the transcript is still redrawable. Computed here rather than
	// inside <Transcript> because the same split decides what the bottom spacer
	// measures: rows in scrollback are content it has to make room for, rows in
	// the window are part of the live region it is padding above. Two
	// computations of one split would drift, and the direction they would drift
	// in is a composer pushed off the screen.
	//
	// A ref, and mutated during render, because the split has to be MONOTONIC:
	// a row that has been printed to scrollback can never come back, and `max`
	// is idempotent, so a repeated render reaches the same answer.
	const window = liveWindow({
		messages: finalized,
		rows: stdout.rows,
		columns: stdout.columns,
		furnitureRows: LIVE_FURNITURE_ROWS,
		settled: settledRef.current,
		raw: rawOutput,
	})
	settledRef.current = window.settled

	// Blank rows above the composer, while the transcript is short enough that
	// the answer is knowable. `liveRows` is the furniture beneath the transcript
	// PLUS the live window above it — the window is part of the live region, and
	// leaving it out would have the spacer padding room that is already taken.
	const spacerCandidate =
		phase === 'ready'
			? bottomSpacerRows({
					rows: stdout.rows,
					columns: stdout.columns,
					transcript: transcriptLines(finalized.slice(0, window.settled), rawOutput),
					liveRows: LIVE_FURNITURE_ROWS + window.rows,
				})
			: 0
	const spacerLayout = {
		rows: stdout.rows,
		columns: stdout.columns,
		raw: rawOutput,
		messageCount: finalized.length,
		tail: finalized
			.slice(-MAX_LIVE_ROWS)
			.map(({ id, content, meta, detail }) => ({ id, content, meta, detail })),
	} satisfies Omit<SpacerLayoutCache, 'spacerRows'>
	const spacerRows =
		phase === 'ready' && sameSpacerLayout(spacerLayoutRef.current, spacerLayout)
			? spacerLayoutRef.current.spacerRows
			: spacerCandidate
	spacerLayoutRef.current =
		phase === 'ready' ? { ...spacerLayout, spacerRows } : null

	// One merged vocabulary for the session: this host's own commands plus
	// whatever the kernel's registry reports. Built here so `/help`, the
	// autocomplete and the dispatcher all answer from the same list — three
	// places that used to read one hardcoded array and would otherwise
	// disagree the moment a capability added a command.
	const hostCommands = mergeHostCommands(kernelCommandDescriptors())

	const slashCtx: SlashContext = {
		cwd: ctx.cwd,
		builtins: hostCommands,
		lastAssistantMessageId: () => lastAssistantMessage.current?.messageId ?? null,
		// Called when `/tools` renders, not read here — the same shape, and the
		// same reason, as `neverPrompted` below.
		availableTools: () => session?.toolNames() ?? [],
		// From the session, not re-resolved: resolving builds a provider, and a
		// second one would describe a different sandbox than the run is using.
		sandbox: session?.sandbox ?? null,
		mcp: () =>
			session
				? (session.mcpStatus?.() ?? {
						connected: session.mcpConnected,
						failed: session.mcpFailed,
					})
				: null,
		providerSummary: session?.providerSummary ?? null,
		modelSummary: session?.modelSummary ?? null,
		reasoningEffort: {
			current: () => reasoningEffortRef.current,
			levels: session?.reasoningEffortLevels,
		},
		// The same state the status bar reads, unformatted. `/cost` prints exact
		// figures where the bar abbreviates to fit.
		usage,
		permissions: {
			currentMode: () => ({
				mode: permissionModeRef.current,
				source: permissionModeSourceRef.current,
			}),
			rules: ctx.rules ?? [],
			// Called when `/permissions` renders, not read here.
			//
			// A boolean would also be correct TODAY, and only by accident: this
			// object is a fresh literal each render and sits in `handleSubmit`'s
			// dependency array, so the callback is rebuilt every render and
			// never holds a stale one. Memoising `slashCtx` is an obvious
			// optimisation for exactly that reason — and it would silently turn
			// a captured boolean stale, putting this security readout back to
			// reporting a posture the operator has already changed. The
			// function keeps that impossible by construction rather than by a
			// coincidence three lines away.
			approvalLatched: () => session?.approvalLatched() ?? false,
			neverPrompted: () => session?.promptExemptTools() ?? [],
		},
		instructionFiles: session?.instructionFiles ?? [],
		userCommands,
		configDebug: ctx.configDebug ?? null,
	}

	// `/resume`: open the picker with this folder's recent conversations.
	const doResume = useCallback(async () => {
		const sessions = sessionsRef.current ?? (await ensureSessions(), sessionsRef.current)
		if (!sessions) {
			pushMessage('system', 'Conversation history is unavailable in this folder.')
			return
		}
		try {
			const recent = await listRecent(sessions)
			// Don't offer the active (empty/just-started) conversation.
			const others = recent.filter((c) => c.id !== scopeRef.current?.sessionId)
			if (others.length === 0) {
				pushMessage('system', 'No past conversations to resume in this folder yet.')
				return
			}
			setResumeList(others)
			setSelectedResume(0)
			setPhase('resume')
		} catch (err) {
			pushMessage(
				'system',
				`Could not list conversations: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}, [ensureSessions, pushMessage])

	// Resolve a pending permission prompt with the user's decision and tear
	// down the overlay. No-op if nothing is pending.
	const resolvePermission = useCallback((decision: PermissionDecision) => {
		const resolve = permissionResolveRef.current
		permissionResolveRef.current = null
		permissionOpenedAtRef.current = null
		setPermission(null)
		if (resolve) resolve(decision)
	}, [])

	/**
	 * Stop the running turn, and hand the screen back in a usable state.
	 *
	 * Returns whether there was one to stop, because the caller has different
	 * things to say in the two cases.
	 *
	 * The screen cleanup lives HERE, at the act that decided to stop, rather
	 * than in the turn's own `finally`. That was safe only while nothing could
	 * start another turn in between. `/resume` can — the abandoned loop unwinds
	 * long after the resumed conversation is on screen, and possibly after a
	 * turn in it has already begun — so a `finally` that resets the composer,
	 * the active tools and the abort handle would be resetting somebody else's.
	 *
	 * The pending permission prompt is settled first. A turn parked on that
	 * promise never reaches its own `finally` at all, so aborting alone would
	 * leave it hanging with its reply unsaved. It is the same decision Ctrl+C
	 * sends at that prompt, for the same reason.
	 */
	const interruptTurn = useCallback((): boolean => {
		if (permissionResolveRef.current)
			resolvePermission({ kind: 'reject', feedback: 'User interrupted.' })
		const ac = abortRef.current
		if (!ac) return false
		ac.abort()
		const activeSessionId = scopeRef.current?.sessionId
		if (activeSessionId) goalActivation.disarm(activeSessionId)
		wakeGoalDriver()
		activeTurnTokenRef.current = null
		activeTurnInboxRef.current = null
		setPendingSteers([])
		// Dropped now so a second interrupt does not re-abort, and the queue with
		// it: interrupting means stop, not "run the next one".
		abortRef.current = null
		discardQueued()
		clearActiveTools()
		setState('idle')
		return true
	}, [clearActiveTools, discardQueued, goalActivation, resolvePermission, wakeGoalDriver])

	/**
	 * Load the chosen conversation into the transcript and continue in it.
	 *
	 * A turn may still be running when this happens — the composer stays live
	 * while the agent works, and a slash action is dispatched ahead of the
	 * message queue — and until this aborted it, three things went wrong at
	 * once. Its rows appended into the resumed transcript. Its queued follow-ups
	 * would have run against a conversation nobody asked them of. And, the one
	 * that outlived the process, its `appendMessages` wrote into the RESUMED
	 * conversation's durable record, because `sessionId` was mutated on a
	 * `RunScope` the running loop held the very same object of.
	 *
	 * The mutation below stays, and it is the sharing that makes it necessary:
	 * `createAgentSession` closed over this exact object and spreads it into
	 * every `query()`, so replacing it here would leave the agent attributing
	 * every future turn to the conversation the operator has left. `RunScope`
	 * says as much — `sessionId` is its one non-`readonly` field. What changed is
	 * on the other side: a turn now fixes its own destination when it starts
	 * (see `runTurn`), so a shared cursor moving under it can no longer decide
	 * where it lands.
	 *
	 * The abandoned turn is not dropped in silence. It goes on consuming its own
	 * events, so its reply is whole, and persists into the conversation it
	 * belongs to; the operator is told that here, because those rows are
	 * correctly absent from the transcript now in front of them, and a turn that
	 * vanishes with no account of where it went is the same defect as one that
	 * lands in the wrong place.
	 *
	 * Nothing is disturbed until the new conversation is actually in hand. A
	 * read that fails leaves a running turn running where it belongs, exactly as
	 * cancelling the picker does.
	 *
	 * And the picker stays up for the length of the read rather than handing the
	 * screen back first. A composer that is live over an unsettled switch takes
	 * a message with nowhere to go: queued against a conversation being left, and
	 * then either dropped by the interrupt below or sent to a conversation nobody
	 * addressed it to. The screen should not accept input for a conversation that
	 * is not decided yet, and a read is usually too fast to see.
	 */
	const resumeConversation = useCallback(
		async (conv: RecentConversation) => {
			const sessions = sessionsRef.current
			const scope = scopeRef.current
			if (!sessions || !scope) {
				setPhase('ready')
				return
			}
			// The operator has committed; `Esc` no longer cancels from here, or a
			// press landing during the read would leave the picker closed and the
			// switch happening anyway.
			resumeCommittedRef.current = true
			let msgs: Awaited<ReturnType<typeof loadConversation>>
			try {
				msgs = await loadConversation(sessions, conv.id)
			} catch (err) {
				resumeCommittedRef.current = false
				setPhase('ready')
				pushMessage(
					'system',
					`Could not resume: ${err instanceof Error ? err.message : String(err)}`,
				)
				return
			}
			resumeCommittedRef.current = false
			setPhase('ready')
			const restored = projectConversation(msgs, nextId)
			// A queue can outlive its turn by one render: the turn has set idle and
			// cleared `abortRef`, while the passive queue pump is paused behind this
			// picker. `interruptTurn` correctly reports no RUNNING turn then, but an
			// early return from it must not make those old prompts cross the switch.
			const discardedQueued = queuedRef.current.length
			const interrupted = interruptTurn()
			discardQueued()
			goalActivation.clear()
			wakeGoalDriver()
			conversationGenRef.current += 1
			activeTurnTokenRef.current = null
			resetTranscript()
			setMessages(restored)
			modelHistoryRef.current = msgs
			setHistory((previous) => [...previous, ...promptHistoryFromConversation(msgs)])
			const persistedOutput = latestAssistantOutput(msgs)
			lastCompletedOutputRef.current = persistedOutput
				? { text: persistedOutput, provenance: 'persisted' }
				: null
			scope.sessionId = conv.id // new turns now attribute to the resumed session
			pushMessage('system', `Resumed: ${conv.title}`)
			if (discardedQueued > 0) {
				pushMessage(
					'system',
					`Discarded ${discardedQueued} queued prompt${discardedQueued === 1 ? '' : 's'} from the conversation you left.`,
				)
			}
			if (interrupted) {
				// "is being saved", not "is saved". The write has not happened yet —
				// it runs when the abandoned turn finishes unwinding, which is after
				// this line — and a surface that reports a result it has not read is
				// the defect class this whole change is about. If that write fails,
				// the turn says so itself, in the same words `run-stream` uses.
				pushMessage(
					'system',
					'The turn that was running was interrupted. Its reply so far is being saved to the conversation it started in, so it is not in the transcript above. A tool call already dispatched was not undone.',
				)
			}
		},
		[
			discardQueued,
			goalActivation,
			interruptTurn,
			nextId,
			pushMessage,
			resetTranscript,
			wakeGoalDriver,
		],
	)

	/**
	 * Start a new conversation without deleting the one being left.
	 *
	 * The durable target is created first. `startConversation` can fail, and an
	 * operator who asked for a new chat must not lose a running turn merely
	 * because its empty successor could not be published. Once it exists, moving
	 * the shared scope and advancing the generation are one synchronous boundary:
	 * old events can still unwind and persist to their captured destination, but
	 * they cannot render into or start an SDK run under the new conversation.
	 *
	 * A process whose initial persistence setup failed has no shared scope to
	 * move. It still gets an honest in-memory context reset; the notice names that
	 * it is not resumable instead of claiming a durable chat was created.
	 */
	const startFreshConversation = useCallback(
		async (clearScreen: boolean) => {
			if (conversationMutationRef.current) return
			conversationMutationRef.current = 'new'
			setConversationMutation('new')

			const sourceScope = scopeRef.current
			const sessions = sessionsRef.current
			let targetSessionId: Awaited<ReturnType<typeof startConversation>> | null = null
			try {
				if (sourceScope) {
					if (!sessions) throw new Error('the active conversation store is unavailable')
					// Publish the recoverable destination before interrupting or clearing
					// anything in the source conversation.
					targetSessionId = await startConversation(sessions)
				}

				const discardedQueued = queuedRef.current.length
				const interrupted = interruptTurn()
				discardQueued()
				goalActivation.clear()
				wakeGoalDriver()
				conversationGenRef.current += 1
				activeTurnTokenRef.current = null
				modelHistoryRef.current = []
				lastAssistantMessage.current = null
				lastCompletedOutputRef.current = null
				setContext(null)
				if (sourceScope && targetSessionId) sourceScope.sessionId = targetSessionId

				if (clearScreen) {
					setMessages([])
					resetTranscript()
				}
				pushMessage(
					'system',
					sourceScope && targetSessionId
						? `Started a fresh conversation. The previous conversation is unchanged and remains in /resume.${
								clearScreen
									? ''
									: " Earlier rows above are display only and are not part of this conversation's model context."
							}`
						: `Started a fresh in-memory conversation because durable session persistence is unavailable.${
								clearScreen
									? ''
									: " Earlier rows above are display only and are not part of this conversation's model context."
							}`,
				)
				if (discardedQueued > 0) {
					pushMessage(
						'system',
						`Discarded ${discardedQueued} queued prompt${discardedQueued === 1 ? '' : 's'} from the conversation you left.`,
					)
				}
				if (interrupted) {
					pushMessage(
						'system',
						'The turn that was running was interrupted. Its reply so far is being saved to the conversation it started in; a tool call already dispatched was not undone.',
					)
				}
			} catch (err) {
				pushMessage(
					'system',
					`Could not start a fresh conversation: ${err instanceof Error ? err.message : String(err)}. The current conversation and any running turn are unchanged.`,
				)
			} finally {
				conversationMutationRef.current = null
				setConversationMutation(null)
			}
		},
		[discardQueued, goalActivation, interruptTurn, pushMessage, resetTranscript, wakeGoalDriver],
	)

	/**
	 * `/rename` (and the older `/title` alias): edit or set the name this
	 * conversation appears under.
	 *
	 * A bare command opens a prefilled host prompt rather than printing usage or
	 * clearing. The result never goes through the model composer, queue, or prompt
	 * history; it is a session-store operation with the session id captured here.
	 */
	const doTitle = useCallback(
		async (title: string, clear: boolean) => {
			const sessions = sessionsRef.current ?? (await ensureSessions(), sessionsRef.current)
			const scope = scopeRef.current
			if (!sessions || !scope) {
				pushMessage('system', 'Conversation history is unavailable in this folder.')
				return
			}
			try {
				if (!clear && title === '') {
					const current = titleOf(sessions, scope.sessionId)
					textPromptTokenRef.current += 1
					setTextPrompt({
						token: textPromptTokenRef.current,
						kind: 'conversation-title',
						title: current === undefined ? 'Name conversation' : 'Rename conversation',
						placeholder: 'Type a name and press Enter',
						emptyNotice: 'A conversation name cannot be empty. Press Esc to cancel.',
						initialValue: current ?? '',
						sessionId: scope.sessionId,
					})
					return
				}
				setTitle(sessions, scope.sessionId, clear ? '' : title)
				pushMessage(
					'system',
					clear
						? 'Name removed. /resume will list this conversation by its opening message again.'
						: `Named "${title}".`,
				)
			} catch (err) {
				pushMessage(
					'system',
					`Could not save the name: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		},
		[ensureSessions, pushMessage, setTextPrompt],
	)

	const submitTextPrompt = useCallback(
		(value: string) => {
			const prompt = textPromptRef.current
			if (!prompt) return
			setTextPrompt(null)

			const scope = scopeRef.current
			if (!scope || scope.sessionId !== prompt.sessionId) {
				pushMessage(
					'system',
					prompt.kind === 'conversation-title'
						? 'The conversation changed while its name editor was open. Nothing was renamed; open /rename again.'
						: 'The conversation changed while its export filename editor was open. Nothing was exported; open /export again.',
				)
				return
			}
			if (prompt.kind === 'export-file') {
				runConversationExport({ kind: 'file', path: value })
				return
			}

			const sessions = sessionsRef.current
			if (!sessions) {
				pushMessage('system', 'Conversation history is unavailable in this folder.')
				return
			}
			try {
				setTitle(sessions, prompt.sessionId, value)
				pushMessage('system', `Named "${value.trim()}".`)
			} catch (error) {
				pushMessage(
					'system',
					`Could not save the name: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		},
		[pushMessage, runConversationExport, setTextPrompt],
	)
	const cancelTextPrompt = useCallback(() => {
		const prompt = textPromptRef.current
		// TextPrompt and App both receive the same Ink input event. Keep the
		// synchronous owner until every listener has seen this Esc/Ctrl+C, or App
		// can read the same key as an interrupt/exit after the child clears the ref.
		queueMicrotask(() => {
			if (textPromptRef.current === prompt) setTextPrompt(null)
		})
	}, [setTextPrompt])

	/**
	 * `/fork`: continue in a copy, leaving this conversation where it is.
	 *
	 * Refused while a turn is running or still unwinding, rather than interrupted
	 * like `/resume` does. The two look similar and are not: `/resume` LEAVES a
	 * conversation, so an interrupted reply landing in the one being left is
	 * where it belongs. A fork stays here — the reply would land in the original,
	 * the screen would go on showing it, and the copy would be missing the last
	 * thing the operator watched arrive.
	 */
	const doFork = useCallback(async () => {
		if (conversationMutationRef.current) return
		if (abortRef.current) {
			pushMessage(
				'system',
				'A turn is still running. Forking now would copy a conversation whose last reply is not in it yet — press esc to stop it, then fork.',
			)
			return
		}
		if (hasUnsettledTurn()) {
			pushMessage(
				'system',
				'A turn is still settling after it was interrupted. Wait for its partial reply to be saved before forking.',
			)
			return
		}
		if (queuedRef.current.length > 0) {
			pushMessage(
				'system',
				'Queued prompts have not run yet. Wait for them to finish before forking.',
			)
			return
		}

		conversationMutationRef.current = 'fork'
		setConversationMutation('fork')
		try {
			const sessions = sessionsRef.current ?? (await ensureSessions(), sessionsRef.current)
			const scope = scopeRef.current
			if (!sessions || !scope) {
				pushMessage('system', 'Conversation history is unavailable in this folder.')
				return
			}
			// The settlement guard above establishes that no current-generation
			// turn can attach another write after this read. The remaining tail may
			// still be writing, so the fork waits for that exact durable snapshot.
			await persistenceTailRef.current
			const original = scope.sessionId
			const forked = await forkConversation(sessions, original)
			// The transcript on screen is already the fork's history, so nothing
			// is reloaded or reset. Only where the NEXT turn is written changes.
			scope.sessionId = forked.id
			goalActivation.clear()
			wakeGoalDriver()
			pushMessage(
				'system',
				`Forked into "${forked.title}" — ${forked.copied} message(s) copied. This screen continues in the copy; ${original} is unchanged and still in /resume.`,
			)
		} catch (err) {
			pushMessage('system', `Could not fork: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			conversationMutationRef.current = null
			setConversationMutation(null)
		}
	}, [ensureSessions, goalActivation, hasUnsettledTurn, pushMessage, wakeGoalDriver])

	/** Open the durable prompt picker after the composer's second empty Esc. */
	const openPromptEditor = useCallback(() => {
		if (conversationMutationRef.current || compactingRef.current) return
		if (abortRef.current || state !== 'idle' || hasUnsettledTurn()) {
			pushMessage(
				'system',
				'A turn is still running or settling. Wait for its reply to be saved before editing earlier history.',
			)
			return
		}
		if (queuedRef.current.length > 0) {
			pushMessage('system', 'Queued prompts must finish before an earlier prompt can be edited.')
			return
		}
		const candidates = editablePrompts(modelHistoryRef.current, messages)
		if (candidates.length === 0) {
			pushMessage('system', 'No previous message to edit.')
			return
		}
		setEditList(candidates)
		setSelectedEdit(candidates.length - 1)
		editCommittedRef.current = false
		setPhase('edit')
	}, [hasUnsettledTurn, messages, pushMessage, state])

	/** Fork before the selected prompt, then reopen that prompt in the composer. */
	const confirmPromptEdit = useCallback(
		async (target: EditablePrompt) => {
			if (editCommittedRef.current || conversationMutationRef.current) return
			if (hasUnsettledTurn() || queuedRef.current.length > 0) {
				setPhase('ready')
				pushMessage(
					'system',
					'Conversation history changed while the prompt picker was open. Nothing was forked; open it again.',
				)
				return
			}

			editCommittedRef.current = true
			conversationMutationRef.current = 'edit'
			setConversationMutation('edit')
			const generation = conversationGenRef.current
			try {
				const sessions = sessionsRef.current ?? (await ensureSessions(), sessionsRef.current)
				const scope = scopeRef.current
				if (!sessions || !scope) {
					setPhase('ready')
					pushMessage('system', 'Conversation history is unavailable in this folder.')
					return
				}
				const source = scope.sessionId
				await persistenceTailRef.current
				if (
					conversationGenRef.current !== generation ||
					scope.sessionId !== source ||
					hasUnsettledTurn(generation)
				) {
					throw new Error('the active conversation changed before the branch could be created')
				}

				const forked = await forkConversationBeforeUser(
					sessions,
					source,
					target.userOrdinal,
					target.message,
				)
				const readablePrefix = editList
					.slice(0, target.userOrdinal)
					.map((prompt) => prompt.displayText)

				conversationGenRef.current += 1
				activeTurnTokenRef.current = null
				goalActivation.clear()
				wakeGoalDriver()
				scope.sessionId = forked.id
				modelHistoryRef.current = forked.messages
				lastAssistantMessage.current = null
				const persistedOutput = latestAssistantOutput(forked.messages)
				lastCompletedOutputRef.current = persistedOutput
					? { text: persistedOutput, provenance: 'persisted' }
					: null

				resetTranscript()
				setMessages(projectConversation(forked.messages, nextId, readablePrefix))
				composerDraftTokenRef.current += 1
				setComposerDraft({
					token: composerDraftTokenRef.current,
					text: target.displayText,
					...(forked.selected.attachments && forked.selected.attachments.length > 0
						? { attachments: [...forked.selected.attachments] }
						: {}),
				})
				setEditList([])
				setPhase('ready')
				pushMessage(
					'system',
					`Forked into "${forked.title}" before the selected prompt. Edit it below; ${source} is unchanged and remains in /resume.`,
				)
			} catch (err) {
				setPhase('ready')
				pushMessage(
					'system',
					`Could not edit the selected prompt: ${err instanceof Error ? err.message : String(err)}`,
				)
			} finally {
				editCommittedRef.current = false
				conversationMutationRef.current = null
				setConversationMutation(null)
			}
		},
		[
			editList,
			ensureSessions,
			goalActivation,
			hasUnsettledTurn,
			nextId,
			pushMessage,
			resetTranscript,
			wakeGoalDriver,
		],
	)

	// Bridge passed into session.send(): the agent calls this before a
	// non-read-only tool batch; it parks until the user presses y/n/a.
	const onPermission = useCallback(
		(req: PermissionRequest) =>
			new Promise<PermissionDecision>((resolve) => {
				permissionResolveRef.current = resolve
				permissionOpenedAtRef.current = Date.now()
				setPermission(req)
				setState('awaiting-permission')
				sendTerminalNotification({ kind: 'approval-required' })
			}),
		[sendTerminalNotification],
	)

	// Render one agent event onto the transcript. Shared by the local turn loop
	// and the daemon-attach poller, so both paths produce identical output.
	// `st` carries the streaming-assistant bubble id + accumulated text across
	// events within a turn/stream.
	const applyEvent = useCallback(
		(event: AgentEvent, st: StreamState) => {
			const ensureAssistant = () => {
				if (!st.assistantId) st.assistantId = pushMessage('assistant', '', true)
				return st.assistantId
			}
			const closeAssistant = () => {
				// Before finalising, never after: the tail of a reply is almost
				// always an incomplete block, so a close that did not flush would
				// drop the last paragraph of nearly every answer.
				flushStream(st)
				if (st.assistantId) {
					finalizeMessage(st.assistantId)
					st.assistantId = null
				}
			}
			switch (event.kind) {
				case 'delta': {
					setState('thinking')
					if (event.messageId && event.runId) {
						lastAssistantMessage.current = {
							runId: event.runId,
							messageId: event.messageId,
						}
					}
					st.text += event.text
					// Held, not appended. Appending each delta is what produced text
					// that types itself out — nothing animates it, but a few
					// characters at a time reads the same way, and an operator ends
					// up watching a line grow instead of reading it.
					st.pending = (st.pending ?? '') + event.text
					const { ready, rest } = splitCompleteBlocks(st.pending)
					if (ready.length > 0) {
						st.pending = rest
						appendToMessage(ensureAssistant(), ready)
					}
					break
				}
				case 'tool-start': {
					closeAssistant()
					setState('tool')
					const tool: RunningTool = {
						id: event.toolUseId,
						toolName: event.toolName,
						label: formatToolCall(event.toolName, event.summary),
						startedAt: Date.now(),
						detail: event.detail,
					}
					activeToolsRef.current = [...activeToolsRef.current, tool]
					setActiveTools(activeToolsRef.current)
					break
				}
				case 'tool-progress': {
					const running = activeToolsRef.current
					const index = running.findIndex((tool) => tool.id === event.toolUseId)
					// A terminal event may already have removed this call. Never recreate
					// a live row from late diagnostic state.
					if (index < 0) break
					const current = running[index] as RunningTool
					const { fraction: _fraction, ...withoutFraction } = current
					const updated: RunningTool = {
						...withoutFraction,
						progress: event.message,
						...(event.fraction !== undefined ? { fraction: event.fraction } : {}),
					}
					activeToolsRef.current = [
						...running.slice(0, index),
						updated,
						...running.slice(index + 1),
					]
					setActiveTools(activeToolsRef.current)
					break
				}
				case 'tool-end': {
					const running = activeToolsRef.current
					// Match strictly by toolUseId. Never fall back to "the first
					// active tool" — under parallel calls that mis-attributes a
					// result to the wrong call. If no id matches, render the
					// completion on its own (label from the end event itself).
					const i = running.findIndex((t) => t.id === event.toolUseId)
					const done = i >= 0 ? running[i] : undefined
					if (i >= 0) {
						activeToolsRef.current = [...running.slice(0, i), ...running.slice(i + 1)]
						setActiveTools(activeToolsRef.current)
					}
					pushMessage(
						'tool',
						done?.label ?? formatToolCall(event.toolName, event.summary),
						false,
						event.isError ? '✗' : '✓',
						done?.detail,
						event.isError ? theme.status.error : theme.status.ok,
						done ? formatElapsed(Date.now() - done.startedAt) : undefined,
					)
					if (event.isError || event.summary.length > 0 || (event.detail?.length ?? 0) > 0) {
						pushMessage(
							'tool',
							event.isError ? `failed: ${event.summary}` : event.summary,
							false,
							'⎿',
							event.detail,
						)
					}
					setState(activeToolsRef.current.length > 0 ? 'tool' : 'thinking')
					break
				}
				case 'usage':
					setUsage({ totalTokens: event.totalTokens, cost: event.cost })
					// Mirrored verbatim, absences included. A run that reports no
					// window clears the gauge rather than leaving the last one up:
					// a stale bar is read as current, and this bar's whole defect
					// was being read as something it was not.
					setContext({
						...(event.contextTokens !== undefined ? { tokens: event.contextTokens } : {}),
						...(event.contextWindowTokens !== undefined
							? { windowTokens: event.contextWindowTokens }
							: {}),
						...(event.contextMeasuredBy !== undefined
							? { measuredBy: event.contextMeasuredBy }
							: {}),
						...(event.windowSource !== undefined ? { windowSource: event.windowSource } : {}),
					})
					break
				case 'task':
					pushMessage('tool', event.subject, false, event.status === 'completed' ? '☑' : '☐')
					break
				case 'context':
					// Into the TRANSCRIPT, not a status line. A status indicator is
					// present while nothing is happening and gone afterwards, so
					// someone reading back could not tell whether the gap they are
					// looking at was compacted. The event is a fact about the
					// conversation and belongs in its record.
					pushMessage('system', event.text, false, event.shed ? '⌫' : '⌦')
					break
				case 'provider-fallback':
					// The transcript, for the reason compaction is in the transcript
					// and one stronger: a status line is gone the moment the next
					// thing happens, and someone reading back a session needs to know
					// which answers came from the provider they picked and which did
					// not. A swap is a permanent fact about this turn.
					pushMessage('system', event.text, false, '⇄')
					break
				case 'capability-warning':
					pushMessage(
						'system',
						`Capability warning (${event.capability}): ${event.text}`,
						false,
						'⚠',
					)
					break
				case 'history-repair':
					pushMessage('system', `History warning (${event.source}): ${event.text}`, false, '⚠')
					break
				case 'done':
					// `run_completed` is not synonymous with success: budgets,
					// cancellation and output guardrails arrive through this event too.
					// Missing remains a normal end for older producers, matching the
					// headless command's compatibility rule.
					st.completed = event.stopReason === undefined || event.stopReason === 'end_turn'
					st.outcome =
						event.stopReason === 'cancelled' ? 'cancelled' : st.completed ? 'completed' : 'stopped'
					st.notification = {
						kind: 'turn-settled',
						outcome: st.completed ? 'completed' : 'stopped',
					}
					closeAssistant()
					break
				case 'error':
					closeAssistant()
					st.outcome = event.message === 'aborted' ? 'cancelled' : 'failed'
					if (event.message !== 'aborted') {
						st.notification = { kind: 'turn-settled', outcome: 'failed' }
						pushMessage('system', `Error: ${event.message}`)
					} else st.notification = null
					break
			}
		},
		[appendToMessage, finalizeMessage, flushStream, pushMessage],
	)

	const runTurn = useCallback(
		async (prompt: QueuedPrompt) => {
			if (!session || !session.hasProvider) {
				pushMessage('system', session?.errorHint ?? 'Agent is not ready yet — give it a moment.')
				return
			}
			const { text } = prompt
			const attachments = prompt.kind === 'human' ? prompt.attachments : undefined
			const goalRound = prompt.kind === 'goal' ? prompt.goalRound : undefined
			if (
				prompt.kind === 'goal' &&
				(prompt.generation !== conversationGenRef.current ||
					scopeRef.current?.sessionId !== goalRound?.sessionId ||
					!goalRound ||
					!goalActivation.isArmed(goalRound.sessionId, goalRound))
			) {
				return
			}
			// Reserve the turn synchronously before the first await below. Leaving
			// state idle while the admission read was pending let a second submit
			// start beside it and broke the queue's FIFO ownership.
			setState('thinking')
			// A conversation can be closed outside this App after it was opened or
			// resumed. Re-check at the actual turn boundary, before expanding file
			// mentions, recording run evidence, or creating a provider iterator.
			// The persistence helpers repeat the same check at their own boundary;
			// neither read is claimed to serialize a concurrent archive (that needs
			// a store-level lease shared with ProjectManager).
			const destination = scopeRef.current?.sessionId ?? null
			const turnSessions = sessionsRef.current
			if (turnSessions && destination) {
				try {
					await requireWritableConversation(turnSessions, destination, 'start conversation turn')
				} catch (err) {
					if (prompt.kind === 'goal' && prompt.goalRound) {
						goalActivation.disarm(prompt.goalRound.sessionId, prompt.goalRound)
						wakeGoalDriver()
					}
					pushMessage(
						'system',
						`This turn was not started: ${err instanceof Error ? err.message : String(err)}`,
					)
					setState('idle')
					return
				}
			}
			// `@path` mentions: the visible human message keeps the readable token,
			// but the model receives the file contents inlined. An automatic goal
			// prompt is already host-authored context and is never reinterpreted as
			// a file-mention command.
			const expanded =
				prompt.kind === 'human'
					? expandFileMentions(text, ctx.cwd)
					: { sendText: text, attached: [] as readonly string[] }
			const { sendText, attached } = expanded
			const historyBeforeTurn = modelHistoryRef.current
			const userMessage = createUserMessage(
				sendText,
				attachments,
				goalRound
					? {
							type: 'goal-round',
							goalId: goalRound.id,
							objective: goalRound.objective,
							goalRevision: goalRound.revision,
							round: goalRound.round,
							maxGoalRounds: goalRound.maxGoalRounds,
						}
					: undefined,
			)
			const priorForSdk: Message[] = [...historyBeforeTurn, userMessage]
			const runId = generateRunId()

			if (goalRound) {
				pushMessage(
					'system',
					`Goal round ${goalRound.round} / ${goalRound.maxGoalRounds}`,
					false,
					'◎',
					[`Objective: ${goalRound.objective}`],
				)
			} else {
				pushMessage(
					'user',
					text,
					false,
					undefined,
					undefined,
					undefined,
					humanPromptMeta(attached.length, attachments),
				)
			}
			// The model interleaves text → tool → text across iterations; `applyEvent`
			// renders each one in order.
			const st: StreamState = {
				assistantId: null,
				text: '',
				conversationMessages: undefined,
				pending: '',
				completed: false,
				outcome: null,
				notification: null,
			}
			const ac = new AbortController()
			const turnToken = {}
			let abnormalTerminal:
				| {
						token: object
						continuationEpoch: number
						outcome: QueuePauseOutcome
				  }
				| undefined
			const markHumanAbnormal = () => {
				if (
					prompt.kind !== 'human' ||
					abnormalTerminal !== undefined ||
					(st.outcome !== 'failed' && st.outcome !== 'stopped')
				)
					return
				abnormalTerminal = {
					token: turnToken,
					continuationEpoch: queueContinuationEpochRef.current,
					outcome: st.outcome,
				}
			}
			abortRef.current = ac
			activeTurnTokenRef.current = turnToken
			// Where this turn will be saved, and which transcript its rows belong
			// to. Both fixed HERE, at the one moment they are knowable.
			//
			// `/resume` can land between this line and the `finally` below, and
			// `abort()` returns long before the loop unwinds — so after a mid-turn
			// switch the finally ALWAYS runs on the far side of it. Reading
			// `scopeRef.current` down there wrote this turn into whichever
			// conversation happened to be open when it finished, and that record
			// outlives the process. A string captured now cannot be reassigned by
			// anyone.
			const turnGeneration = conversationGenRef.current
			unsettledTurnGenerationsRef.current.set(turnToken, turnGeneration)
			const stillHere = (): boolean => conversationGenRef.current === turnGeneration
			let inboxOpen = true
			const inboxEntries: LiveInput[] = []
			const inbox: ActiveTurnInbox = {
				accept(input): boolean {
					if (
						!inboxOpen ||
						ac.signal.aborted ||
						!stillHere() ||
						activeTurnTokenRef.current !== turnToken ||
						activeTurnInboxRef.current !== inbox
					)
						return false
					inboxEntries.push(input)
					setPendingSteers([...inboxEntries])
					return true
				},
				drain(): Message[] {
					if (
						!inboxOpen ||
						ac.signal.aborted ||
						activeTurnTokenRef.current !== turnToken ||
						activeTurnInboxRef.current !== inbox ||
						inboxEntries.length === 0
					)
						return []
					const delivered = inboxEntries.splice(0, inboxEntries.length)
					// This callback runs at the kernel's provider-valid boundary: every
					// delta from the prior answer has already crossed the event stream.
					// Commit the user rows here, not at keypress time, so the transcript
					// cannot place a steer inside an assistant message that is still live.
					if (stillHere()) {
						flushStream(st)
						if (st.assistantId) {
							finalizeMessage(st.assistantId)
							st.assistantId = null
						}
						for (const input of delivered) {
							pushMessage(
								'user',
								input.prompt.text,
								false,
								undefined,
								undefined,
								undefined,
								humanPromptMeta(input.attachedFiles, input.prompt.attachments, true),
							)
						}
						setPendingSteers([])
					}
					return delivered.map((input) => input.message)
				},
				close(): readonly LiveInput[] {
					inboxOpen = false
					return inboxEntries.splice(0, inboxEntries.length)
				},
			}
			activeTurnInboxRef.current = inbox
			const turnPermissionMode = permissionModeRef.current
			const turnReasoningEffort = reasoningEffortRef.current
			// Always carry the guarded callback. `auto` and `strict` decide before
			// calling it in makeResumeHandler; retaining it is what lets a session
			// launched with --yolo later return to prompt mode truthfully.
			const askPermission = (req: PermissionRequest): Promise<PermissionDecision> => {
				if (!stillHere() || activeTurnTokenRef.current !== turnToken || ac.signal.aborted) {
					return Promise.resolve({
						kind: 'reject',
						feedback: 'Turn is no longer active.',
					})
				}
				return onPermission(req)
			}
			let evidenceTurn: ConversationTurnStartedRecord | undefined
			let evidenceReady = goalRound === undefined
			if (turnSessions?.turnEvidence && destination) {
				try {
					evidenceTurn = await turnSessions.turnEvidence.recordTurnStarted({
						sessionId: destination,
						runId,
						displayText: text,
						user: userMessage,
					})
					evidenceReady = true
				} catch (err) {
					if (goalRound) {
						goalActivation.disarm(goalRound.sessionId, goalRound)
						wakeGoalDriver()
						pushMessage(
							'system',
							`Goal round ${goalRound.round} was not started because its durable evidence could not be recorded: ${err instanceof Error ? err.message : String(err)}. Automatic continuation is disarmed; /goal resume retries explicitly.`,
						)
					} else {
						pushMessage(
							'system',
							`Could not record durable evidence for this turn before run ${runId}: ${err instanceof Error ? err.message : String(err)}. The turn will continue, but a complete export of conversation ${destination} will refuse rather than omit it.`,
						)
					}
				}
			} else if (goalRound) {
				goalActivation.disarm(goalRound.sessionId, goalRound)
				wakeGoalDriver()
				pushMessage(
					'system',
					`Goal round ${goalRound.round} was not started because durable turn evidence is unavailable. Automatic continuation is disarmed; /goal resume retries explicitly.`,
				)
			}
			try {
				// `recordTurnStarted` is an awaited durability boundary. A conversation
				// switch can happen while it is pending and move the mutable RunScope
				// captured by `createAgentSession`. Re-admit the turn here, immediately
				// before the generator exists, or an abandoned prompt can initialize its
				// reserved SDK run under the new conversation.
				if (
					evidenceReady &&
					!ac.signal.aborted &&
					stillHere() &&
					activeTurnTokenRef.current === turnToken &&
					(!goalRound ||
						(destination === goalRound.sessionId &&
							goalActivation.isArmed(goalRound.sessionId, goalRound)))
				) {
					for await (const event of session.send(priorForSdk, {
						signal: ac.signal,
						runId,
						permissionMode: turnPermissionMode,
						...(turnReasoningEffort !== undefined ? { effort: turnReasoningEffort } : {}),
						...(goalRound ? { goalRound } : {}),
						// The mode above decides whether this callback is consulted.
						onPermission: askPermission,
						inboundMessages: () => inbox.drain(),
						extraSystem: composeSkillsPrompt(activeSkills) ?? undefined,
						onConversationMessages: (messages) => {
							// State-only: opaque reasoning/signatures must reach the next
							// provider and durable store without becoming transcript text.
							st.conversationMessages = messages
						},
					})) {
						// A turn the operator has left is consumed but not rendered: no row
						// from it lands in a transcript it has nothing to do with, and its
						// text keeps accumulating so that what gets saved does not depend
						// on exactly when the switch happened.
						//
						// How much arrives after the switch is a property of the SESSION,
						// not of this loop. The built-in one checks the signal at the top of
						// each iteration and returns after a single `error: aborted`, so in
						// practice very little does. The accumulation is here so a session
						// that notices later — a different implementation, a generator
						// parked in a tool call — still saves a whole reply rather than one
						// truncated at the moment the operator happened to leave.
						if (stillHere()) {
							applyEvent(event, st)
							markHumanAbnormal()
						} else if (event.kind === 'delta') st.text += event.text
					}
				} else {
					st.outcome = 'cancelled'
				}
			} catch (err) {
				// Reported only where it means something. In the conversation the
				// operator has moved on from, this row would be the same misplacement
				// the generation exists to stop — and it would be the more confusing
				// half of it, because an abort reads as an error.
				if (stillHere()) {
					if (!ac.signal.aborted) {
						st.outcome = 'failed'
						st.notification = { kind: 'turn-settled', outcome: 'failed' }
						markHumanAbnormal()
					}
					// Flushed first: this path does not go through `applyEvent`, so
					// without it the partial answer the model had produced before
					// the failure would be discarded along with the turn.
					flushStream(st)
					if (st.assistantId) finalizeMessage(st.assistantId)
					pushMessage('system', `Error: ${err instanceof Error ? err.message : String(err)}`)
				}
			} finally {
				const undeliveredLiveInput = inbox.close()
				const ownsInbox = activeTurnInboxRef.current === inbox
				if (ownsInbox) {
					activeTurnInboxRef.current = null
					setPendingSteers([])
				}
				// Prefer the kernel's settled conversation projection: it retains opaque
				// reasoning, citations and complete tool turns that the visible delta
				// stream cannot reconstruct. A fake/legacy session that does not publish
				// one keeps the old text-only shape. The visible transcript still keeps
				// the operator's readable `@file` token; both persistence paths keep what
				// was actually sent, including expanded contents and attachments.
				const fallbackTurn: Message[] = goalRound && !evidenceReady ? [] : [userMessage]
				if (st.text.trim().length > 0) fallbackTurn.push(createAssistantMessage(st.text))
				const conversationMessages =
					goalRound && !evidenceReady ? undefined : st.conversationMessages
				const publication = conversationMessages
					? planTurnPublication(historyBeforeTurn, userMessage, conversationMessages)
					: ({ kind: 'append', messages: fallbackTurn } as const)
				const nextModelHistory = conversationMessages ?? [...historyBeforeTurn, ...fallbackTurn]
				if (goalRound && (ac.signal.aborted || st.outcome !== 'completed')) {
					goalActivation.disarm(goalRound.sessionId, goalRound)
					wakeGoalDriver()
				}
				// The screen belongs to the conversation on it, which after a
				// `/resume` is no longer this turn's. `interruptTurn` already did this
				// cleanup at the moment it decided to stop; repeating it here would
				// clear the state of whatever has started since.
				if (stillHere()) {
					const ownsTurn = activeTurnTokenRef.current === turnToken
					if (ownsInbox && undeliveredLiveInput.length > 0) {
						replaceQueued(mergeUndeliveredLiveInput(queuedRef.current, undeliveredLiveInput))
					}
					const shouldPauseQueued =
						ownsTurn &&
						abnormalTerminal?.token === turnToken &&
						abnormalTerminal.continuationEpoch === queueContinuationEpochRef.current &&
						queuedRef.current.length > 0
					if (shouldPauseQueued && abnormalTerminal) {
						setQueuePause({ outcome: abnormalTerminal.outcome })
					}
					modelHistoryRef.current = nextModelHistory
					if (st.completed && st.text.trim().length > 0) {
						lastCompletedOutputRef.current = {
							text: st.text,
							provenance: 'normal-completion',
						}
					}
					// Unguarded, and it can be: a second turn cannot start in the
					// conversation this one is running in — the composer queues instead
					// — so within one generation this handle is still ours. An
					// `=== ac` comparison here read as prudence and was a check that
					// could not fail, which teaches the next reader that the checks
					// around it are decoration too.
					abortRef.current = null
					if (ownsTurn) activeTurnTokenRef.current = null
					permissionResolveRef.current = null
					permissionOpenedAtRef.current = null
					setPermission(null)
					clearActiveTools()
					setState('idle')
					if (
						ownsTurn &&
						!ac.signal.aborted &&
						!goalRound &&
						st.notification &&
						(queuedRef.current.length === 0 || shouldPauseQueued)
					) {
						sendTerminalNotification(st.notification)
					}
				}
				// Persisted either way, and into the conversation this turn was
				// started in — captured above, never re-read.
				//
				// Best-effort is about not FAILING, not about staying quiet. The
				// rejection used to be swallowed whole, and it is the one failure here
				// that makes a LATER surface wrong: `/resume` comes back missing a
				// turn that was on screen, and the next turn in that conversation
				// silently lacks it as context, with nothing connecting either to a
				// write that failed minutes ago. `run-stream` already says this, in
				// these words and for this reason.
				//
				// Said wherever the operator is now, even when that is a different
				// conversation, because there is no other channel and it is news they
				// need. Naming the conversation is what keeps it from reading as a
				// fault of the one in front of them.
				if (
					turnSessions &&
					destination &&
					(publication.kind === 'replace' || publication.messages.length > 0 || evidenceTurn)
				) {
					persistenceTailRef.current = persistenceTailRef.current.then(async () => {
						if (evidenceTurn && turnSessions.turnEvidence) {
							try {
								await turnSessions.turnEvidence.recordTurnSettled({
									sessionId: destination,
									turnId: evidenceTurn.turnId,
									runId,
									outcome: ac.signal.aborted
										? 'cancelled'
										: (st.outcome ?? (st.completed ? 'completed' : 'stopped')),
									assistantText: st.text,
								})
							} catch (err) {
								pushMessage(
									'system',
									`Could not finish the durable evidence for turn ${evidenceTurn.turnId}: ${err instanceof Error ? err.message : String(err)}. A complete export of conversation ${destination} will refuse if the SDK run record cannot prove the missing text.`,
								)
							}
						}
						try {
							if (publication.kind === 'replace') {
								await replaceConversation(turnSessions, destination, publication.messages)
							} else if (publication.messages.length > 0) {
								await appendMessages(turnSessions, destination, publication.messages)
							}
						} catch (err) {
							if (goalRound) {
								goalActivation.disarm(goalRound.sessionId, goalRound)
								wakeGoalDriver()
							}
							pushMessage(
								'system',
								`A turn was not saved to conversation ${destination}: ${
									err instanceof Error ? err.message : String(err)
								}. Its durable history will not include it. It remains only in this process's in-memory context if that conversation is still open; resuming or restarting will lose it.`,
							)
						}
					})
				}
				// Removed only AFTER the write has been attached to the tail. A history
				// operation that sees no current-generation entries can now await that
				// tail without a turn appearing behind its read later.
				unsettledTurnGenerationsRef.current.delete(turnToken)
			}
		},
		[
			activeSkills,
			applyEvent,
			clearActiveTools,
			ctx.cwd,
			finalizeMessage,
			flushStream,
			goalActivation,
			onPermission,
			pushMessage,
			replaceQueued,
			sendTerminalNotification,
			session,
			setQueuePause,
			wakeGoalDriver,
		],
	)

	const handleSubmit = useCallback(
		(
			value: string,
			attachments?: readonly MessageAttachment[],
			mode: ComposerSubmitMode = 'submit',
		) => {
			if (goalCommandInFlightRef.current) {
				pushMessage(
					'system',
					'A goal command is still reaching durable session state. Wait for its result before sending another command or prompt.',
				)
				return
			}
			if (exportingRef.current) {
				pushMessage(
					'system',
					'A verified conversation export is still being written. Wait for its result before sending another command or prompt.',
				)
				return
			}
			if (conversationMutationRef.current) {
				const operation =
					conversationMutationRef.current === 'fork'
						? 'forked'
						: conversationMutationRef.current === 'edit'
							? 'branched for prompt editing'
							: conversationMutationRef.current === 'archive'
								? 'archived'
								: 'moved to a fresh conversation'
				pushMessage(
					'system',
					`Conversation history is being ${operation}. Wait for it to finish before sending another command or prompt.`,
				)
				return
			}
			setHistory((prev) => [...prev, value])
			// What actually gets sent. A `prompt` action replaces it with text the
			// command composed, and then takes the ordinary send path below —
			// including the queue — so a command-driven turn is not a second way
			// to run one.
			let outgoing = value
			const slash = runSlash(value, slashCtx, hostCommands)
			if (slash) {
				switch (slash.kind) {
					case 'message':
						pushMessage(slash.role, slash.content)
						return
					case 'command-picker': {
						if (slash.commands.length === 0) {
							pushMessage('system', 'No slash commands are available in this session.')
							return
						}
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'command',
							title: 'Choose a command',
							notice: 'Enter runs the selected command; Esc returns to the composer.',
							values: slash.commands,
							options: slash.commands.map((command) => ({
								label: `/${command.name}`,
								description: command.problem
									? `Unavailable: ${command.problem}`
									: command.description,
							})),
							windowSize: suggestionWindowSize(stdout.rows),
						})
						return
					}
					case 'clear-screen':
						setMessages([])
						resetTranscript()
						return
					case 'composer-draft':
						composerDraftTokenRef.current += 1
						setComposerDraft({
							token: composerDraftTokenRef.current,
							text: slash.text,
						})
						return
					case 'new-conversation':
						void startFreshConversation(slash.clearScreen)
						return
					case 'archive-picker': {
						if (!sessionsRef.current || !scopeRef.current?.sessionId) {
							pushMessage(
								'system',
								'Cannot archive this conversation because durable session persistence is unavailable.',
							)
							return
						}
						if (
							state !== 'idle' ||
							abortRef.current !== null ||
							hasUnsettledTurn() ||
							queuedRef.current.length > 0 ||
							compactingRef.current ||
							exportingRef.current
						) {
							pushMessage(
								'system',
								'A turn, queued prompt, compaction, or export is still running or settling. Archive waits for a stable durable boundary.',
							)
							return
						}
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'archive-conversation',
							title: 'Archive this conversation?',
							notice:
								'History remains on disk for inspection, but the conversation becomes read-only and disappears from /resume.',
							values: ['cancel', 'archive'],
							options: [
								{
									label: 'No, keep conversation',
									description: 'Return without changing durable history',
								},
								{
									label: 'Yes, archive and exit',
									description: 'Make this conversation read-only and leave Namzu',
								},
							],
						})
						return
					}
					case 'exit':
						exitWithSummary()
						return
					case 'repick':
						// Opened as a choice, not as a repair. A launch-time refusal
						// left on screen here would explain a problem that has since
						// been solved — the session behind this picker is running.
						setPickerNotice(null)
						setKeyEntryFor(null)
						setPickerDetected(null)
						setPickerSelectionKind('provider-and-model')
						setPickerInitialView('providers')
						setPhase('picker')
						return
					case 'permission-mode': {
						applyPermissionMode(slash.mode)
						return
					}
					case 'permission-mode-picker': {
						if (!session?.hasProvider) {
							pushMessage(
								'system',
								'No active session — pick a provider before changing permissions.',
							)
							return
						}
						if (
							state !== 'idle' ||
							abortRef.current !== null ||
							hasUnsettledTurn() ||
							queuedRef.current.length > 0 ||
							permissionResolveRef.current !== null ||
							compactingRef.current ||
							!session.resetApprovalLatch
						) {
							pushMessage(
								'system',
								'Permission choices are unavailable until the active turn, prompt, compaction, queued work, or embedded-session approval latch can be safely settled.',
							)
							return
						}
						const values = ['prompt', 'auto', 'strict'] as const
						setSelectedChoice(Math.max(0, values.indexOf(permissionModeRef.current)))
						setChoicePicker({
							kind: 'permission-mode',
							title: 'Select Permission Mode',
							notice: permissionPickerNotice(session),
							values,
							options: values.map((mode) => ({
								label: mode,
								description: permissionModeDescription(mode),
								current: mode === permissionModeRef.current,
							})),
						})
						return
					}
					case 'reasoning-effort': {
						applyReasoningEffort(slash.effort ?? undefined)
						return
					}
					case 'reasoning-effort-picker': {
						const levels = session?.reasoningEffortLevels
						if (!session?.hasProvider || levels === undefined) {
							pushMessage(
								'system',
								'No exact reasoning-effort menu is available for the current session.',
							)
							return
						}
						if (
							state !== 'idle' ||
							abortRef.current !== null ||
							hasUnsettledTurn() ||
							queuedRef.current.length > 0 ||
							permissionResolveRef.current !== null ||
							compactingRef.current
						) {
							pushMessage(
								'system',
								'Reasoning-effort choices are unavailable until the active turn, prompt, compaction, and queued work settle.',
							)
							return
						}
						const values: readonly (ReasoningEffort | undefined)[] = [undefined, ...levels]
						const current = reasoningEffortRef.current
						setSelectedChoice(
							Math.max(
								0,
								values.findIndex((value) => value === current),
							),
						)
						setChoicePicker({
							kind: 'reasoning-effort',
							title: `Select Reasoning Level for ${session.modelSummary ?? 'current model'}`,
							values,
							options: values.map((effort) => ({
								label: effort ?? 'default',
								description: reasoningEffortDescription(effort),
								current: effort === current,
							})),
						})
						return
					}
					case 'login':
						void startOrFinishLogin(slash.pasted)
						return
					case 'logout': {
						if (slash.target) {
							removeStoredCredential(slash.target)
							return
						}
						const choices = [
							...(readStoredSubscriptionCredential() ? (['anthropic'] as const) : []),
							...(readStoredCodexCredential() ? (['codex'] as const) : []),
						]
						if (choices.length === 0) {
							removeStoredCredential('all')
							return
						}
						if (choices.length === 1) {
							removeStoredCredential(choices[0] as SubscriptionProviderId)
							return
						}
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'credential-logout',
							title: 'Choose a stored subscription to remove',
							notice:
								'Only credentials created by Namzu are listed. Device sessions owned by other tools are left alone.',
							values: choices,
							options: choices.map((choice) => ({
								label: choice === 'anthropic' ? 'Claude' : 'Codex',
								description:
									choice === 'anthropic'
										? 'Remove only Namzu’s Claude subscription.'
										: 'Remove only Namzu’s Codex subscription.',
							})),
						})
						return
					}
					case 'remember':
						try {
							appendMemory(slash.text)
							pushMessage('system', `Remembered: ${slash.text}`)
						} catch (err) {
							pushMessage(
								'system',
								`Could not save memory: ${err instanceof Error ? err.message : String(err)}`,
							)
						}
						return
					case 'show-memory': {
						const mem = composeMemoryPrompt(readMemory())
						pushMessage(
							'system',
							mem ?? 'Nothing remembered yet. Use /remember <text>, or edit ~/.namzu/MEMORY.md.',
						)
						return
					}
					case 'list-skills': {
						// The session's directory, not the process's — the same
						// distinction the headless commands get from `--cwd`. They are
						// the same value today, and were the same value in `run-stream`
						// too until they were not.
						const skills = discoverSkills({ cwd: ctx.cwd })
						if (skills.length === 0) {
							pushMessage(
								'system',
								'No skills found. Add one at ~/.namzu/skills/<name>/SKILL.md or ./skills/<name>/SKILL.md.',
							)
							return
						}
						const activeNames = new Set(activeSkills.map((s) => s.name))
						const lines = skills.map((s) =>
							// A refused skill is shown with its reason rather than hidden.
							// Dropping it silently would leave someone wondering where a
							// file they can see on disk went.
							s.problem
								? `⚠ ${s.name} — ${s.problem}`
								: `${activeNames.has(s.name) ? '● ' : '○ '}${s.name} — ${s.description}`,
						)
						pushMessage('system', `Skills (● active):\n  ${lines.join('\n  ')}`)
						return
					}
					case 'skill-picker': {
						const skills = discoverSkills({ cwd: ctx.cwd })
						if (skills.length === 0) {
							pushMessage(
								'system',
								'No skills found. Add one at ~/.namzu/skills/<name>/SKILL.md or ./skills/<name>/SKILL.md.',
							)
							return
						}
						const activeNames = new Set(activeSkills.map((skill) => skill.name))
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'skill',
							title: 'Activate a skill',
							values: skills.map((skill) => skill.name),
							options: skills.map((skill) => ({
								label: skill.name,
								description: skill.problem
									? `Unavailable: ${skill.problem}`
									: `${skill.description} · ${skill.source}`,
								current: activeNames.has(skill.name),
							})),
						})
						return
					}
					case 'load-skill': {
						activateSkill(slash.name)
						return
					}
					case 'resume':
						void doResume()
						return
					case 'title':
						void doTitle(slash.title, slash.clear)
						return
					case 'fork':
						void doFork()
						return
					case 'expand': {
						// Resolved INSIDE the updater, against `prev`.
						//
						// Not against the `messages` this callback captured: rows arrive
						// from `applyEvent` while a turn runs, which is exactly when
						// someone types `/expand`, and a captured array can be a render
						// behind — so "the most recent one" would sometimes mean the one
						// before it, and the command would quietly show the wrong output.
						// `prev` is by definition the latest.
						//
						// And against the ROWS, not a parallel index of them. An earlier
						// draft kept a ref mirroring `{ref, label, lines}` alongside the
						// rows that already hold all three. That is one concept in two
						// shapes with a hand-written copy between them — the geometry
						// `docs/conventions/one-site-is-not-every-site.md` names as the
						// hardest kind to spot, adopted here to solve a staleness problem
						// the updater solves without it.
						//
						// The id is taken outside so both branches use the same one.
						const id = nextId()
						setMessages((prev) => {
							const blocks = prev.filter((m) => m.detailRef !== undefined)
							const say = (content: string): TranscriptMessage => ({
								id,
								role: 'system',
								content,
							})
							if (blocks.length === 0) {
								return [
									...prev,
									say(
										'Nothing to expand yet. Tool output longer than six lines collapses with a "… +N lines · /expand n" hint, and that number is what this takes.',
									),
								]
							}
							const block =
								slash.which === 'last'
									? blocks[blocks.length - 1]
									: blocks.find((m) => m.detailRef === slash.which)
							if (!block) {
								// Names the range rather than only refusing: the operator's
								// next move is to type a different number, and they should
								// not have to guess which ones exist.
								return [
									...prev,
									say(
										`No collapsed output numbered ${slash.which}. This conversation has ${
											blocks.length === 1
												? 'one, numbered 1'
												: `${blocks.length}, numbered 1 to ${blocks.length}`
										}.`,
									),
								]
							}
							// A NEW row carrying the same lines, flagged to print them all.
							// Not a mutation of the row that collapsed them: that row was
							// handed to <Static>, which emits an item once and calls the
							// render function only for items it has not emitted yet, so
							// nothing decided now can reach it. Appending is the only
							// expansion this architecture has.
							//
							// The lines travel as `detail` rather than flattened into the
							// content so the `▏` rule and the +/- diff colouring survive.
							// An expansion that showed LESS than the collapsed form would
							// be a strange thing to have asked for.
							//
							// It carries no `detailRef` of its own: it is already in full,
							// so there is nothing for a number to offer, and giving it one
							// would let `/expand` produce a third copy of the same output.
							return [
								...prev,
								{
									id,
									role: 'system',
									content: `${block.content} — in full (${block.detail?.length ?? 0} lines)`,
									glyph: '⤢',
									detail: block.detail,
									detailExpanded: true,
								},
							]
						})
						return
					}
					case 'prompt':
						// Deliberately does NOT return: the composed text falls
						// through to the same queue-or-send below that a typed
						// message takes.
						outgoing = slash.text
						break
					case 'none':
						return
					case 'host-command': {
						// Dispatched through the kernel's registry, built with what
						// THIS session can answer from. The descriptors used for
						// the merge above carry no store — they are names — so the
						// registry is rebuilt here with the live one.
						const durableSessions = sessionsRef.current
						const runScope = scopeRef.current
						const generation = conversationGenRef.current
						const goalCommand = slash.name === 'goal'
						if (goalCommand) goalCommandInFlightRef.current = true
						const registry = new HostCommandRegistry()
						registry.register(
							kernelHostCommands({
								allowedAgentIds: session?.agentIds ?? [],
								...(durableSessions && runScope
									? {
											goal: {
												store: durableSessions.goals,
												sessionId: runScope.sessionId,
												tenantId: durableSessions.tenantId,
												activation: goalActivation,
											},
										}
									: {}),
							}),
						)
						void (async () => {
							try {
								const outcome = await registry.dispatch(
									`/${slash.name} ${slash.args.join(' ')}`.trim(),
								)
								// A late readout from the conversation just left must not be
								// painted as state of the one now on screen.
								if (conversationGenRef.current !== generation) return
								pushMessage(
									'system',
									outcome
										? renderOutcome(outcome)
										: `/${slash.name} is registered but this session cannot run it.`,
								)
							} catch (error) {
								if (conversationGenRef.current !== generation) return
								pushMessage(
									'system',
									`Could not run /${slash.name}: ${error instanceof Error ? error.message : String(error)}`,
								)
							} finally {
								if (goalCommand) {
									goalCommandInFlightRef.current = false
									wakeGoalDriver()
								}
							}
						})()
						return
					}
					case 'feedback-picker': {
						const target = lastAssistantMessage.current
						if (!target || target.messageId !== slash.messageId) {
							pushMessage('system', 'Nothing to rate yet.')
							return
						}
						const values = ['good', 'bad'] as const
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'feedback-rating',
							title: 'Rate the latest answer',
							runId: target.runId,
							messageId: target.messageId,
							values,
							options: [
								{
									label: 'good',
									description: 'The answer was useful and correct.',
								},
								{ label: 'bad', description: 'The answer needs improvement.' },
							],
						})
						return
					}
					case 'feedback': {
						const target = lastAssistantMessage.current
						if (!target || target.messageId !== slash.messageId) {
							pushMessage('system', 'Nothing to rate yet.')
							return
						}
						recordFeedback(target.runId, slash.messageId, slash.rating, slash.note)
						return
					}
					case 'review': {
						if (slash.instructions) {
							// Custom instructions are already operator-authored model input.
							// They take the ordinary FIFO below rather than a second send path.
							outgoing = slash.instructions
							break
						}
						const values: readonly ReviewPreset[] = [
							'base-branch',
							'uncommitted',
							'commit',
							'custom',
						]
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'review-preset',
							title: 'Select a review preset',
							values,
							options: [
								{
									label: 'Base branch',
									description: 'Review the current work as a branch comparison.',
								},
								{
									label: 'Uncommitted',
									description: 'Review staged, unstaged, and untracked changes.',
								},
								{
									label: 'Commit',
									description: 'Review one recent commit.',
								},
								{
									label: 'Custom',
									description: 'Write exact review instructions in the composer.',
								},
							],
						})
						return
					}
					case 'diff': {
						// Fire-and-forget, like its neighbours: a git invocation is not
						// something to block a keystroke on.
						void (async () => {
							const { summary, detail } = renderWorkspaceDiff(await workspaceDiff(ctx.cwd))
							setMessages((prev) => [
								...prev,
								{
									id: `diff-${Date.now()}`,
									role: 'system',
									content: summary,
									...(detail.length > 0 ? { detail } : {}),
								},
							])
						})()
						return
					}
					case 'compact': {
						if (!session) {
							pushMessage('system', 'No session yet — nothing to compact.')
							return
						}
						if (abortRef.current || state !== 'idle' || hasUnsettledTurn()) {
							pushMessage(
								'system',
								'A turn is still running or settling. Compacting now would summarize a conversation while its next message is being written — wait for it to finish, or press esc to stop it and wait for its partial reply to be saved.',
							)
							return
						}
						if (compactingRef.current) return
						compactingRef.current = true
						setCompacting(true)
						setState('thinking')
						// Fire-and-forget, the same shape `feedback` above uses: this
						// switch is synchronous while compaction and its optional
						// verifier are asynchronous. The transcript reports the outcome.
						void (async () => {
							try {
								// The same lossless record `runTurn` reads — including an earlier
								// compaction summary and attachments. The transcript is only its
								// rendered view and is never reverse-engineered into history.
								const result = await session.compact(modelHistoryRef.current)
								if (!result) {
									// Not an error, and not silence: a conversation too short
									// to shed anything is a real answer to a question the
									// operator asked on purpose.
									pushMessage(
										'system',
										'Nothing to compact yet — this conversation is short enough that adding a summary would save no messages.',
									)
									return
								}

								// Durable first, screen second. Reporting success and only then
								// discovering `/resume` still has the old history is the exact
								// false-success state this command used to create.
								const sessions = sessionsRef.current
								const destination = scopeRef.current?.sessionId
								if (sessions && destination) {
									await persistenceTailRef.current
									await replaceConversation(sessions, destination, result.messages)
								}
								modelHistoryRef.current = result.messages
								// The old gauge measured the history that was just replaced.
								// Clear it only after the durable projection and live model
								// history agree; until then the old measurement is still the
								// truthful one. The next run publishes a fresh measurement.
								setContext(null)

								// How many user/assistant turns survived the pass.
								// `keepRecentRows` explains why the transcript is trimmed
								// to match rather than rebuilt from `result.messages`.
								const keptTurns = result.messages.filter(
									(m) => m.role === 'user' || m.role === 'assistant',
								).length

								// The summary belongs before the surviving turns. `<Static>` only
								// emits items beyond the index it has already printed, so prepending
								// into the mounted transcript makes the summary invisible. Remount
								// the projection just as `/resume` does when it replaces the log.
								resetTranscript()
								setMessages((prev) => {
									const summaryRow: TranscriptMessage = {
										id: `compact-${Date.now()}`,
										role: 'system',
										content: `Compacted ${result.shed} earlier message(s) into a summary.${
											result.usage.totalTokens > 0
												? ` Verifier used ${result.usage.totalTokens.toLocaleString('en-US')} tokens.`
												: ''
										}${
											sessions && destination
												? ''
												: ' Conversation persistence is unavailable, so this compacted history lasts only for this process.'
										}`,
										detail: summaryDetail(result.summary),
									}
									return [summaryRow, ...keepRecentRows(prev, keptTurns)]
								})
							} catch (err) {
								pushMessage(
									'system',
									`Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
								)
							} finally {
								compactingRef.current = false
								setCompacting(false)
								setState('idle')
							}
						})()
						return
					}
					case 'copy': {
						const target = lastCompletedOutputRef.current
						if (!target) {
							pushMessage(
								'system',
								'Nothing to copy yet — /copy applies to the latest assistant answer that finished normally.',
							)
							return
						}
						setSelectedCopy(0)
						setCopyPicker({
							targets: copyTargetsForResponse(target.text),
							provenance: target.provenance,
						})
						return
					}
					case 'raw': {
						const enabled = slash.enabled === 'toggle' ? !rawOutput : slash.enabled
						// Rows already emitted by <Static> cannot observe a new render
						// function. Clear the terminal, reset its monotone floor and
						// remount the retained rows so this is a transcript-wide mode,
						// not a flag that reaches only future output.
						setRawOutput(enabled)
						resetTranscript()
						pushMessage(
							'system',
							enabled
								? 'Raw output mode on — transcript source is shown without Markdown styling or collapsed bodies; terminal controls remain visible escapes.'
								: 'Raw output mode off — rich transcript rendering restored.',
						)
						return
					}
					case 'export-picker': {
						if (!stableExportSource()) return
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'export-destination',
							title: 'Export conversation',
							notice: 'Save the complete verified conversation as Markdown.',
							values: ['clipboard', 'file'],
							options: [
								{
									label: 'Copy to clipboard',
									description: 'Send the verified Markdown transcript to the terminal clipboard',
								},
								{
									label: 'Save to file',
									description: 'Choose a Markdown filename; existing files are never overwritten',
								},
							],
						})
						return
					}
					case 'export': {
						runConversationExport({ kind: 'file', path: slash.path })
						return
					}
					default: {
						// Exhaustive on purpose. Without it a `SlashAction` kind added
						// and not handled here falls out of the switch into the send
						// path below — so `/somenewcommand` would be dispatched to the
						// MODEL as prose, silently, which is both a wrong answer and a
						// tool call the operator did not ask for. This turns that into
						// a build failure.
						const exhaustive: never = slash
						void exhaustive
						return
					}
				}
			}
			// Every model-bound prompt enters one FIFO, including one submitted while
			// idle. If idle submissions bypassed it, a prompt arriving after a turn's
			// `setState('idle')` but before the passive drain effect could start ahead
			// of an older queued prompt. The drain below is the only turn starter.
			//
			// Keep the attachment array beside its text. Reconstructing a prompt from
			// the transcript later cannot recover bytes whose composer chip is gone.
			advanceQueueContinuation()
			const prompt: HumanQueuedPrompt = {
				kind: 'human',
				text: outgoing,
				...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
			}
			if (mode === 'submit') {
				const inbox = activeTurnInboxRef.current
				if (inbox) {
					const expanded = expandFileMentions(outgoing, ctx.cwd)
					if (
						inbox.accept({
							prompt,
							message: createUserMessage(expanded.sendText, prompt.attachments),
							attachedFiles: expanded.attached.length,
							queueBoundary: queuedRef.current.length,
						})
					)
						return
				}
			}
			enqueueQueued(prompt)
		},
		[
			activeSkills,
			advanceQueueContinuation,
			applyPermissionMode,
			applyReasoningEffort,
			ctx.cwd,
			doResume,
			enqueueQueued,
			exitWithSummary,
			hasUnsettledTurn,
			nextId,
			pushMessage,
			rawOutput,
			removeStoredCredential,
			resetTranscript,
			runConversationExport,
			setChoicePicker,
			setCopyPicker,
			setReasoningEffort,
			slashCtx,
			stableExportSource,
			startFreshConversation,
			state,
			stdout.rows,
		],
	)
	// `applyChoiceSelection` is declared before `handleSubmit` because the
	// picker is also used by review/export flows. Keep only this dispatch hop in
	// a ref so selecting a help row re-enters the one ordinary slash-command
	// path instead of growing a second command executor.
	commandPickerSubmitRef.current = handleSubmit

	// Keep the footer on the same durable goal record the driver mutates. A ref
	// alone cannot repaint React, so every goal mutation bumps goalDriveVersion;
	// generation/session checks stop a late disk read labelling a resumed chat.
	useEffect(() => {
		void goalDriveVersion
		const sessions = sessionsRef.current
		const scope = scopeRef.current
		if (!sessions?.goals || !scope) {
			setGoalStatus(null)
			return
		}
		const generation = conversationGenRef.current
		const sessionId = scope.sessionId
		let disposed = false
		void sessions.goals
			.getGoal(sessionId, sessions.tenantId)
			.then((goal) => {
				if (
					disposed ||
					conversationGenRef.current !== generation ||
					scopeRef.current?.sessionId !== sessionId
				) {
					return
				}
				setGoalStatus(goal)
			})
			.catch(() => {
				if (!disposed && conversationGenRef.current === generation) setGoalStatus(null)
			})
		return () => {
			disposed = true
		}
	}, [goalDriveVersion, phase, session])

	// Admit automatic work only at a whole-App durable boundary. This effect
	// reserves; it never starts a turn itself. The one queue pump below remains
	// the sole starter, which is what keeps a human prompt that arrives during
	// admission ahead of the resulting goal round.
	useEffect(() => {
		void goalDriveVersion
		// The ref is the synchronous gate; this state read is the wake-up edge.
		// A failed fork/edit can close its mutation boundary while the screen stays
		// idle, so no other dependency would necessarily re-run this driver.
		void conversationMutation
		if (
			goalDriveInFlightRef.current ||
			state !== 'idle' ||
			phase !== 'ready' ||
			!session?.hasProvider ||
			queuedRef.current.length > 0 ||
			abortRef.current ||
			hasUnsettledTurn() ||
			conversationMutationRef.current ||
			exportingRef.current ||
			compactingRef.current ||
			textPromptRef.current ||
			choicePickerRef.current ||
			copyPickerRef.current ||
			goalCommandInFlightRef.current
		) {
			return
		}
		const durableSessions = sessionsRef.current
		const scope = scopeRef.current
		if (!durableSessions?.turnEvidence || !scope) return
		const generation = conversationGenRef.current
		const sessionId = scope.sessionId
		const armed = goalActivation.get(sessionId)
		if (!armed) return

		goalDriveInFlightRef.current = true
		void (async () => {
			try {
				await persistenceTailRef.current
				if (
					conversationGenRef.current !== generation ||
					scopeRef.current?.sessionId !== sessionId ||
					state !== 'idle' ||
					abortRef.current ||
					hasUnsettledTurn(generation) ||
					conversationMutationRef.current ||
					exportingRef.current ||
					compactingRef.current ||
					textPromptRef.current ||
					choicePickerRef.current ||
					copyPickerRef.current ||
					goalCommandInFlightRef.current ||
					queuedRef.current.length > 0 ||
					!goalActivation.isArmed(sessionId, armed)
				) {
					return
				}

				const current = await durableSessions.goals.getGoal(sessionId, durableSessions.tenantId)
				if (
					!current ||
					current.phase !== 'active' ||
					current.id !== armed.id ||
					current.revision !== armed.revision
				) {
					goalActivation.disarm(sessionId, armed)
					return
				}

				const authority = await durableSessions.goals.admitRound(
					sessionId,
					durableSessions.tenantId,
					armed,
				)
				// Human input may have entered or even started while admission was on
				// disk; keep it. The goal round appends after that FIFO. A conversation
				// or goal command is different: it revoked this scheduling boundary.
				if (
					conversationGenRef.current !== generation ||
					scopeRef.current?.sessionId !== sessionId ||
					conversationMutationRef.current ||
					goalCommandInFlightRef.current ||
					!goalActivation.isArmed(sessionId, armed)
				) {
					goalActivation.disarm(sessionId, armed)
					return
				}
				goalActivation.arm(authority)
				enqueueQueued({
					kind: 'goal',
					text: goalRoundPrompt(authority),
					goalRound: authority,
					generation,
				})
			} catch (error) {
				goalActivation.disarm(sessionId, armed)
				if (error instanceof GoalRoundLimitError) {
					pushMessage(
						'system',
						`Goal blocked after ${error.goal.roundsAdmitted} admitted round${error.goal.roundsAdmitted === 1 ? '' : 's'}: ${error.goal.blockedReason?.message ?? 'the round limit was reached'}`,
					)
				} else if (!(error instanceof StaleGoalError)) {
					pushMessage(
						'system',
						`Automatic goal continuation was disarmed because round admission failed: ${error instanceof Error ? error.message : String(error)}. Run /goal resume to retry explicitly.`,
					)
				}
			} finally {
				goalDriveInFlightRef.current = false
				wakeGoalDriver()
			}
		})()
	}, [
		enqueueQueued,
		goalActivation,
		goalDriveVersion,
		hasUnsettledTurn,
		phase,
		pushMessage,
		conversationMutation,
		session,
		state,
		textPrompt,
		choicePicker,
		copyPicker,
		wakeGoalDriver,
	])

	// Drain the queue: when a turn settles (idle) and nothing is running,
	// send the next queued message automatically.
	useEffect(() => {
		if (
			state !== 'idle' ||
			phase !== 'ready' ||
			queuedRef.current.length === 0 ||
			queuePauseRef.current !== null ||
			abortRef.current ||
			hasUnsettledTurn() ||
			conversationMutationRef.current ||
			exportingRef.current ||
			compactingRef.current ||
			textPromptRef.current ||
			choicePickerRef.current ||
			copyPickerRef.current ||
			goalCommandInFlightRef.current
		)
			return
		// Read and remove from the synchronous source of truth. `queued` is the
		// render snapshot that scheduled this effect; a later input may already
		// have appended to the ref, and replacing from that old snapshot would
		// erase it.
		const next = dequeueQueued()
		if (next !== undefined) void runTurn(next)
	}, [
		state,
		phase,
		queued,
		queuePause,
		textPrompt,
		choicePicker,
		copyPicker,
		dequeueQueued,
		hasUnsettledTurn,
		runTurn,
	])

	// One-shot update check on launch.
	// Best-effort; surfaces a single notice when something newer is out.
	const updateCheckedRef = useRef(false)
	useEffect(() => {
		if (phase !== 'ready' || updateCheckedRef.current) return
		updateCheckedRef.current = true
		void checkUpdates(ctx.version).then((ups) => {
			if (ups.length === 0) return
			const lines = ups.map((u) => `  • ${u.name} ${u.current} → ${u.latest}  (${u.how})`)
			pushMessage('system', `⬆ Update available:\n${lines.join('\n')}`)
		})
	}, [phase, ctx.version, pushMessage])

	const hydrateFromPicker = useCallback(
		async (
			prefs: Preferences,
			detectedNow: readonly DetectedProvider[],
			signal: AbortSignal,
			revealAllOnFailure = false,
		): Promise<void> => {
			try {
				await hydrateSession(prefs, detectedNow, signal)
			} catch (err) {
				// A superseded choice no longer owns even its failure message. Its
				// eventual session object is disposed inside `hydrateSession`; a live
				// choice stays on the picker with the actionable construction error.
				if (signal.aborted) return
				if (revealAllOnFailure) {
					setPickerDetected(null)
					setPickerSelectionKind('provider-and-model')
					setPickerInitialView('providers')
				}
				setPickerNotice(
					`Could not start the selected provider: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		},
		[hydrateSession],
	)

	/**
	 * A credential the operator typed. Held in memory for this process only.
	 *
	 * Deliberately does NOT call `writePreferences`: preferences are a file, and
	 * the whole contract of this entry point is that nothing lands on disk. The
	 * provider choice is not persisted either, because persisting it would leave
	 * a preference pointing at a credential that will not exist next launch.
	 */
	const handleTypedCredential = useCallback(
		(credential: DetectedProvider, disposition: string, signal: AbortSignal) => {
			const next = [credential, ...detected.filter((d) => d.entry.id !== credential.entry.id)]
			setDetected(next)
			setKeyEntryFor(null)
			setPickerDetected(null)
			setPickerSelectionKind('provider-and-model')
			setPickerNotice(null)
			// The disposition, not the key. `credential` never reaches a message.
			pushMessage('system', disposition)
			// The SAVED chain when the credential is for the provider that was
			// already chosen, and a fresh one-member chain otherwise. Rebuilding
			// from the id alone would have been a quiet demotion in the one case
			// this routing creates: an operator whose file pins a model, and whose
			// only problem was a missing secret, would have been moved onto the
			// registry default for supplying it.
			const saved = savedPrefsRef.current
			const prefs: Preferences =
				saved && primaryProvider(saved).id === credential.entry.id
					? saved
					: {
							version: 3,
							providers: [{ id: credential.entry.id as ProviderId }],
							subagents: { active: [] },
						}
			void hydrateFromPicker(prefs, next, signal)
		},
		[detected, hydrateFromPicker, pushMessage],
	)

	const handlePickerSubmit = useCallback(
		(selection: { provider: string; model?: string }, signal: AbortSignal) => {
			// One member for now. The picker builds a longer chain in a later
			// change; the shape it writes into is already the chain.
			const prefs: Preferences = {
				version: 3,
				providers: [
					{
						id: selection.provider as ProviderId,
						...(selection.model !== undefined ? { model: selection.model } : {}),
					},
				],
				subagents: { active: [] },
			}
			setKeyEntryFor(null)
			setPickerNotice(null)
			try {
				writePreferences(prefs)
			} catch (err) {
				pushMessage(
					'system',
					`Could not save preferences: ${err instanceof Error ? err.message : String(err)}`,
				)
				return
			}
			// Keep a narrowed signed-in roster stable while construction is pending.
			// Only a real refusal broadens back to the general, sign-in-capable picker.
			void hydrateFromPicker(prefs, detected, signal, true)
		},
		[detected, hydrateFromPicker, pushMessage],
	)

	/**
	 * Leaving the picker returns to whatever was on screen before it.
	 *
	 * The picker has two entry points and used to have one exit. Opened by
	 * `/model` from a working session, cancelling sent the operator to
	 * `unhealthy` — a phase with a disabled composer, from which `/model` cannot
	 * be typed again — so declining to change model threw away the session they
	 * already had.
	 *
	 * `unhealthy` means namzu tried and cannot serve: it is set when a probe
	 * throws, and when a session comes up with no provider, both carrying an
	 * `errorHint` saying what failed. Cancelling is not a failure, and borrowing
	 * the failure phase to express it is what made a working session look broken.
	 *
	 * With nothing behind the picker — first run, no session — there is no screen
	 * to return to, so leaving the picker is leaving the program. That is also
	 * what the empty picker's own footer has always claimed `esc` does.
	 */
	const handlePickerCancel = useCallback(() => {
		setPickerInitialView('providers')
		setPickerDetected(null)
		setPickerSelectionKind('provider-and-model')
		if (session?.hasProvider) {
			setPhase('ready')
			return
		}
		exitWithSummary()
	}, [session, exitWithSummary])

	useInput(
		(input, key) => {
			// The provider picker owns its own keyboard — arrows, digits, enter,
			// esc and the typed-key screen are all its business. Ctrl+C is not: it
			// is the one key that must work on every screen, and this handler used
			// to be switched off for the whole picker phase. Ink runs with
			// `exitOnCtrlC: false` and raw mode means the tty raises no SIGINT, so
			// nothing else was going to answer it.
			//
			// One press, not the two the ready screen asks for. The ladder works by
			// printing "press again" into the transcript, and the transcript is not
			// rendered during the picker — so the old behaviour was not quite "the
			// key is dead" but the worse "the first press does something invisible
			// and the second exits", with nothing on screen naming either.
			if (phase === 'picker') {
				if (key.ctrl && input === 'c') exitWithSummary()
				return
			}
			// Previous-prompt picker owns the keyboard. Esc keeps stepping toward
			// older prompts, matching the second Esc that opened it; q is the cancel.
			if (phase === 'edit') {
				if (editCommittedRef.current) return
				if ((key.ctrl && input === 'c') || input.toLowerCase() === 'q') {
					setEditList([])
					setPhase('ready')
					return
				}
				if (key.home || key.end || key.pageUp || key.pageDown) {
					setSelectedEdit((index) =>
						moveSelection(
							index,
							editList.length,
							key.home
								? 'first'
								: key.end
									? 'last'
									: key.pageUp
										? 'previous-page'
										: 'next-page',
						),
					)
					return
				}
				if (key.escape || key.leftArrow || key.upArrow) {
					setSelectedEdit((index) => moveSelection(index, editList.length, 'previous'))
					return
				}
				if (key.rightArrow || key.downArrow) {
					setSelectedEdit((index) => moveSelection(index, editList.length, 'next'))
					return
				}
				if (key.return) {
					const target = editList[selectedEditRef.current]
					if (target) void confirmPromptEdit(target)
				}
				return
			}
			// Resume picker owns the keyboard while open.
			if (phase === 'resume') {
				// Once a conversation is being read, the keyboard does nothing here.
				// The choice is already being acted on; a second Enter would start a
				// second read and an Esc would hand back a screen that is about to be
				// replaced regardless.
				if (resumeCommittedRef.current) return
				if (key.home || key.end || key.pageUp || key.pageDown) {
					setSelectedResume((index) =>
						moveSelection(
							index,
							resumeList.length,
							key.home
								? 'first'
								: key.end
									? 'last'
									: key.pageUp
										? 'previous-page'
										: 'next-page',
						),
					)
				} else if (key.upArrow)
					setSelectedResume((index) => moveSelection(index, resumeList.length, 'previous'))
				else if (key.downArrow)
					setSelectedResume((index) => moveSelection(index, resumeList.length, 'next'))
				else if (key.return) {
					const conv = resumeList[selectedResumeRef.current]
					if (conv) void resumeConversation(conv)
				} else if (key.escape || (key.ctrl && input === 'c')) setPhase('ready')
				return
			}
			// Trust gate owns the keyboard until the folder is trusted or we exit.
			if (phase === 'trust') {
				const ch = input.toLowerCase()
				// Refusal answers on the first press and is never deferred. It only
				// exits: nothing is written, nothing has run, and a relaunch costs a
				// second — so an accidental refusal is the recoverable direction,
				// and making the escape hatch hesitate on the program's first screen
				// would read as a hang.
				if (ch === 'n' || key.escape || (key.ctrl && input === 'c')) {
					exitWithSummary()
					return
				}
				// Enter is deliberately NOT trust, for the reason it is not approval
				// at the tool prompt — and more so here. The operator reached this
				// screen by typing `namzu` and pressing Enter, so a key repeat or an
				// impatient second press arrives while the gate is still painting;
				// this is the one moment in the program where an in-flight Enter is
				// close to expected. And the decision is durable: `acceptTrust`
				// writes the folder into `~/.namzu/trust.json`, which covers every
				// subfolder, so a stray keystroke grants standing permission to a
				// whole tree rather than to one call.
				if (!approvalIsDeliberate(trustShownAtRef.current, Date.now())) return
				if (ch === 'y') acceptTrust()
				return
			}
			// A pending permission prompt owns the keyboard: y/n/a decide it.
			if (permissionResolveRef.current) {
				const ch = input.toLowerCase()
				// Refusing is never deferred or gated — it is the direction a
				// mistake is recoverable in, so it answers on the first press.
				if (key.ctrl && input === 'c') {
					resolvePermission({ kind: 'reject', feedback: 'User interrupted.' })
					abortRef.current?.abort()
					return
				}
				if (ch === 'n' || key.escape) {
					resolvePermission({ kind: 'reject' })
					return
				}
				// Enter is deliberately NOT an approval. It is the key people press
				// to dismiss a thing that appeared, it is the key already in flight
				// when a turn's follow-up was being typed, and it is named nowhere
				// on this prompt — so reading it as consent approves a tool call the
				// operator never looked at. `y` and `a` are the only approvals, and
				// they must arrive after the prompt has been up long enough to read.
				if (!approvalIsDeliberate(permissionOpenedAtRef.current, Date.now())) return
				if (ch === 'y') resolvePermission({ kind: 'approve' })
				else if (ch === 'a') resolvePermission({ kind: 'approve-all' })
				return
			}
			// A host-owned text prompt has its own input hook. This synchronous ref
			// claims the interval before React paints it too, so App cannot read a
			// key repeat as an interrupt, exit ladder, or finite-menu choice.
			if (textPromptRef.current) return
			// Finite slash-command choices own the keyboard below a live permission
			// request and above the ordinary composer. Their values are a captured
			// menu, so a provider/session change cannot silently reinterpret Enter.
			if (choicePickerRef.current) {
				const picker = choicePickerRef.current
				// Composer publishes a chooser while handling Return. App receives the
				// same input dispatch (and key repeat can arrive before the commit), so
				// the synchronous ref is an ownership fence but not yet an actionable
				// menu. Only the exact object React committed may consume a choice.
				if (choicePickerCommittedRef.current !== picker) return
				const options = picker.options
				if (key.escape || (key.ctrl && input === 'c')) {
					reviewChoiceInFlightRef.current = null
					setChoicePicker(null)
					return
				}
				if (key.home || key.end || key.pageUp || key.pageDown) {
					const pageSize = picker.kind === 'command' ? picker.windowSize : undefined
					setSelectedChoice((index) =>
						moveSelection(
							index,
							options.length,
							key.home
								? 'first'
								: key.end
									? 'last'
									: key.pageUp
										? 'previous-page'
										: 'next-page',
							pageSize,
						),
					)
					return
				}
				if (key.upArrow) {
					setSelectedChoice((index) => moveSelection(index, options.length, 'previous'))
					return
				}
				if (key.downArrow) {
					setSelectedChoice((index) => moveSelection(index, options.length, 'next'))
					return
				}
				if (key.return) {
					applyChoiceSelection(selectedChoiceRef.current)
					return
				}
				if (/^[1-9]$/.test(input)) {
					const index = Number(input) - 1
					if (options[index]) applyChoiceSelection(index)
				}
				return
			}
			// `/copy` holds a source snapshot, not a lifecycle phase. Permission
			// stays above it in this handler so an approval request that arrives
			// while the picker is open cannot have its keys stolen by the chooser.
			if (copyPickerRef.current) {
				const targets = copyPickerRef.current.targets
				if (key.escape || (key.ctrl && input === 'c')) {
					setCopyPicker(null)
					return
				}
				if (key.home || key.end || key.pageUp || key.pageDown) {
					setSelectedCopy((index) =>
						moveSelection(
							index,
							targets.length,
							key.home
								? 'first'
								: key.end
									? 'last'
									: key.pageUp
										? 'previous-page'
										: 'next-page',
						),
					)
					return
				}
				if (key.upArrow) {
					setSelectedCopy((index) => moveSelection(index, targets.length, 'previous'))
					return
				}
				if (key.downArrow) {
					setSelectedCopy((index) => moveSelection(index, targets.length, 'next'))
					return
				}
				if (key.return) {
					sendCopyRequest(selectedCopyRef.current)
					return
				}
				if (/^[1-9]$/.test(input)) {
					const index = Number(input) - 1
					if (targets[index]) sendCopyRequest(index)
				}
				return
			}
			// Terminal-native display clear. It deliberately shares `/clear-screen`'s
			// view-only boundary: model history, durable history and the active
			// conversation remain untouched. A live turn is refused instead of
			// erasing the only visible account of work that is still changing.
			if (key.ctrl && input === 'l') {
				if (state !== 'idle' || abortRef.current || hasUnsettledTurn()) {
					pushMessage('system', 'Ctrl+L is unavailable while a turn is still in progress.')
					return
				}
				setMessages([])
				resetTranscript()
				return
			}
			// Esc interrupts a running turn (Ctrl+C stays reserved for exit). Mirrors
			// the Ctrl+C interrupt path: abort, drop the queue, one "Interrupted." line.
			if (key.escape && abortRef.current) {
				interruptTurn()
				pushMessage('system', 'Interrupted.')
				return
			}
			// Ctrl+O expands the collapsed bodies that are still redrawable.
			//
			// It was advertised — on every collapsed body — as toggling full
			// expansion for everything, and in that use it did nothing: finalized
			// rows went through `<Static>`, which renders `items.slice(index)` and
			// calls the render function only for items it has not emitted yet, so
			// output already on screen was beyond its reach. Measured, with a
			// twelve-line body up: pressing it produced one further frame whose
			// transcript region was byte-identical to the one before.
			//
			// The rows at the end of the transcript are now drawn live rather than
			// printed once, so for those the key does what it always claimed —
			// flipping the flag re-renders the row where it already is. It reaches
			// exactly as far back as the window does, and says so when that is
			// nowhere. It does not quietly fall back to appending a copy: `/expand`
			// is that, deliberately and visibly, and a key that sometimes redraws
			// in place and sometimes prints a second copy further down would be two
			// commands wearing one name.
			if (key.ctrl && input === 'o') {
				// Taken outside the updater so both branches use the same one, as
				// `/expand` does.
				const id = nextId()
				setMessages((prev) => {
					const live = prev.filter((m) => !m.pending).slice(settledRef.current)
					const collapsible = live.filter((m) => willCollapse(m.detail))
					if (collapsible.length === 0) {
						return [
							...prev,
							{
								id,
								role: 'system' as const,
								content:
									'Nothing on screen can be expanded in place. Only the last few rows stay redrawable; anything older has been printed to the terminal’s own scrollback, which cannot be rewritten. Use /expand <n> for those — the number is in the hint under each collapsed body, and /expand on its own takes the most recent.',
							},
						]
					}
					// Expanded unless they are all open already, in which case this
					// closes them again — the toggle it was always described as.
					const expanding = collapsible.some((m) => m.detailExpanded !== true)
					const ids = new Set(collapsible.map((m) => m.id))
					return prev.map((m) => (ids.has(m.id) ? { ...m, detailExpanded: expanding } : m))
				})
				return
			}
			if (key.ctrl && input === 'c') {
				// A turn is running → first Ctrl+C interrupts it, not exits.
				// Drops the ref, so a second Ctrl+C arms exit instead of re-aborting
				// (which spammed "Interrupted." lines).
				if (interruptTurn()) {
					pushMessage('system', 'Interrupted.')
					return
				}
				if (exitArmedRef.current) {
					exitWithSummary()
					return
				}
				exitArmedRef.current = true
				pushMessage('system', 'Press Ctrl+C again to exit.')
				setTimeout(() => {
					exitArmedRef.current = false
				}, 2000)
			}
		},
		// Active on every phase. It was gated off during the picker, which is what
		// left that screen without a usable exit; the picker branch above returns
		// immediately, so the Picker still owns everything except Ctrl+C.
		{ isActive: externalEditorRequest === null },
	)

	// Background is left natural — we inherit the terminal's own background
	// and only theme the foreground. Forcing
	// a filled bg left mismatched patches around bordered areas, so we don't.
	return (
		<Box flexDirection="column" display={externalEditorRequest ? 'none' : 'flex'}>
			<Box flexDirection="column" paddingX={1}>
				{phase === 'trust' ? (
					<TrustPrompt cwd={ctx.cwd} />
				) : phase === 'resume' ? (
					<ResumePicker conversations={resumeList} selected={selectedResume} />
				) : phase === 'edit' ? (
					<EditPromptPicker prompts={editList} selected={selectedEdit} />
				) : phase === 'picker' ? (
					<Picker
						detected={pickerDetected ?? detected}
						currentProvider={currentProvider}
						selectionKind={pickerSelectionKind}
						currentModel={session?.modelSummary ?? null}
						initialView={pickerInitialView}
						onSubmit={handlePickerSubmit}
						onCancel={handlePickerCancel}
						onCredential={handleTypedCredential}
						onLogin={startLoginFromPicker}
						onLoginComplete={finishLoginFromPicker}
						keyEntryFor={keyEntryFor}
						notice={pickerNotice}
					/>
				) : (
					<>
						<TranscriptFrame>
							<Transcript
								messages={finalized}
								pending={messages.find((m) => m.pending) ?? null}
								state={state}
								settled={window.settled}
								resetKey={resetKey}
								raw={rawOutput}
								hyperlinks={hyperlinks}
								header={
									phase === 'ready' ? (
										<Banner
											version={ctx.version}
											session={session}
											permissionMode={permissionMode}
											cwd={ctx.cwd}
										/>
									) : undefined
								}
							/>
						</TranscriptFrame>
						{/* Conversation rows flow from the banner downward. The remaining
						    viewport belongs below the transcript, so the composer can stay near
						    the terminal bottom without pushing a short conversation down with it. */}
						{spacerRows > 0 ? <Box height={spacerRows} /> : null}
						<LiveActivity
							activeTools={activeTools}
							thinking={state === 'thinking' && !messages.some((m) => m.pending)}
						/>
						{/* Siblings, not a ternary. The overlay used to REPLACE the
						    composer, which unmounted it and destroyed whatever the
						    operator was part-way through typing — text, paste chips
						    and pasted images alike — on an event they did not
						    trigger. The composer now stays mounted and draws
						    nothing while the prompt is up, so its state survives a
						    decision it had nothing to do with. */}
						{permission ? <PermissionOverlay toolCalls={permission.toolCalls} /> : null}
						{textPrompt ? (
							<TextPrompt
								key={textPrompt.token}
								title={textPrompt.title}
								placeholder={textPrompt.placeholder}
								initialValue={textPrompt.initialValue}
								emptyNotice={textPrompt.emptyNotice}
								hidden={permission !== null}
								onSubmit={submitTextPrompt}
								onCancel={cancelTextPrompt}
							/>
						) : permission === null && choicePicker ? (
							<ChoicePicker
								title={choicePicker.title}
								notice={choicePicker.notice}
								options={choicePicker.options}
								selected={selectedChoice}
								windowSize={
									choicePicker.kind === 'command' ? choicePicker.windowSize : undefined
								}
							/>
						) : permission === null && copyPicker ? (
							<CopyPicker targets={copyPicker.targets} selected={selectedCopy} />
						) : null}
						<ComposerFrame
							focus={
								state === 'idle' &&
								phase === 'ready' &&
								conversationMutation === null &&
								textPrompt === null &&
								choicePicker === null &&
								copyPicker === null
							}
							hidden={permission !== null || choicePicker !== null || copyPicker !== null}
						>
							{pendingSteers.length > 0 &&
							permission === null &&
							textPrompt === null &&
							choicePicker === null &&
							copyPicker === null ? (
								<Box paddingX={1}>
									<Text color={theme.accent.user}>
										↳ {pendingSteers.length} message
										{pendingSteers.length > 1 ? 's' : ''} steering the active turn — waiting for its
										next response boundary
									</Text>
								</Box>
							) : null}
							{queued.length > 0 &&
							permission === null &&
							textPrompt === null &&
							choicePicker === null &&
							copyPicker === null ? (
								<Box paddingX={1}>
									<Text color={theme.text.muted}>
										{queuePause ? '⏸' : '⏎'} {queued.length} message
										{queued.length > 1 ? 's' : ''} queued —{' '}
										{queuePause
											? `paused after a ${queuePause.outcome} turn; send a message or change model to continue`
											: 'sending when ready'}
									</Text>
								</Box>
							) : null}
							<Composer
								disabled={
									phase !== 'ready' ||
									state === 'awaiting-permission' ||
									compacting ||
									conversationMutation !== null ||
									externalEditorRequest !== null
								}
								hidden={
									permission !== null ||
									textPrompt !== null ||
									choicePicker !== null ||
									copyPicker !== null
								}
								// A turn is running, so Esc is the interrupt and not
								// the composer's clear.
								escapeInterrupts={!compacting && (state === 'thinking' || state === 'tool')}
								onSubmit={handleSubmit}
								onNotice={(text) => pushMessage('system', text)}
								onExternalEdit={requestExternalEditor}
								onEditPrevious={openPromptEditor}
								draftToRestore={composerDraft}
								onDraftRestored={(token) =>
									setComposerDraft((draft) => (draft?.token === token ? null : draft))
								}
								userCommands={userCommands}
								mentionCandidates={mentionCandidates}
								history={history}
							/>
						</ComposerFrame>
					</>
				)}
				<Box paddingTop={1}>
					<StatusBar
						cwd={ctx.cwd}
						provider={session?.providerSummary ?? null}
						model={session?.modelSummary ?? null}
						effort={reasoningEffort ?? 'default'}
						goal={
							phase === 'ready' &&
							state === 'idle' &&
							conversationMutation === null &&
							!compacting &&
							permission === null &&
							textPrompt === null &&
							choicePicker === null &&
							copyPicker === null
								? goalStatusLabel(goalStatus)
								: null
						}
						state={state}
							hint={
								conversationMutation === 'fork'
									? 'forking conversation — input is paused'
									: conversationMutation === 'edit'
										? 'branching before prompt — input is paused'
										: conversationMutation === 'archive'
											? 'archiving conversation — input is paused'
										: conversationMutation === 'new'
										? 'starting a fresh conversation — input is paused'
										: compacting
											? 'compacting conversation — input is paused'
											: permission
												? hintForPhase(phase, state, session?.hasProvider === true)
												: textPrompt
													? 'name editor open — enter save · esc cancel'
													: choicePicker
														? 'choice open — ↑↓ / 1–9 select · enter apply · esc cancel'
														: copyPicker
															? 'copy target open — ↑↓ / 1–9 select · esc cancel'
															: goalStatus && phase === 'ready' && state === 'idle'
																? undefined
																: hintForPhase(phase, state, session?.hasProvider === true)
						}
						usage={usage}
						context={context}
					/>
				</Box>
			</Box>
		</Box>
	)
}

function Banner({
	version,
	session,
	permissionMode,
	cwd,
}: {
	readonly version: string
	readonly session: AgentSession | null
	readonly permissionMode: PermissionMode
	readonly cwd: string
}) {
	const cols = process.stdout.columns ?? 80
	const wide = cols >= NAMZU_WORDMARK_MIN_WIDTH
	const provider = session?.providerSummary
	const model = session?.modelSummary
	const home = process.env.HOME
	const prettyCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
	return (
		<Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
			<Box flexDirection="row">
				{wide ? (
					<Box flexDirection="column" marginRight={2}>
						{NAMZU_WORDMARK.map((line, i) => (
							<Text key={`wm-${i}`} color={NAMZU_WORDMARK_GRADIENT[i]} bold>
								{line}
							</Text>
						))}
					</Box>
				) : (
					<Text color={NAMZU_MARK_COLOR}>{NAMZU_MARK} </Text>
				)}
				{/* Center the meta column against the 5-row wordmark. */}
				<Box flexDirection="column" marginTop={wide ? 1 : 0}>
					<Text>
						<Text color={theme.text.secondary}>Cogitave</Text>
						{/* Wide layout already spells "namzu" in the wordmark, so the
						    text avoids repeating it; the compact fallback keeps it. */}
						{wide ? null : (
							<Text color={NAMZU_MARK_COLOR} bold>
								{' '}
								Namzu
							</Text>
						)}
						<Text color={theme.text.muted}> v{version}</Text>
					</Text>
					<Text color={theme.text.secondary}>
						{provider ? `${provider}${model ? ` · ${model}` : ''}` : 'the agent in your terminal'}
					</Text>
					<Text color={theme.text.muted}>{prettyCwd}</Text>
				</Box>
			</Box>
			{permissionMode === 'auto' ? (
				<Box marginTop={1}>
					<Text color={theme.status.error} bold>
						⚠ launched in auto permission mode — undecided tools run without asking until
						/permissions changes it
					</Text>
				</Box>
			) : null}
		</Box>
	)
}

function TranscriptFrame({ children }: { readonly children: React.ReactNode }) {
	// Borderless, edge-to-edge — the message glyph gutter provides structure.
	return <Box flexDirection="column">{children}</Box>
}

function ComposerFrame({
	focus,
	hidden = false,
	children,
}: {
	readonly focus: boolean
	/**
	 * Draw no frame, but keep the children mounted.
	 *
	 * The border is dropped rather than the Box, and that is not a style
	 * preference. React reconciles by element type at a position: returning
	 * `<>{children}</>` here instead of `<Box>{children}</Box>` changes the
	 * type, which unmounts and remounts the subtree — the exact destruction
	 * this component exists to prevent, reintroduced by the guard meant to
	 * prevent it. The first version of this fix did that and the tests caught
	 * it. So the Box is unconditional and only its decoration varies; the
	 * children render nothing while hidden, so an undecorated Box around
	 * nothing prints nothing.
	 */
	readonly hidden?: boolean
	readonly children: React.ReactNode
}) {
	// Input-field look: a rounded rule above and below the composer, no side
	// borders, so the input reads as a field rather than a heavy box.
	return (
		<Box
			flexDirection="column"
			{...(hidden ? {} : { borderStyle: 'round' as const })}
			borderTop={true}
			borderBottom={true}
			borderLeft={false}
			borderRight={false}
			borderColor={focus ? theme.border.focus : theme.border.default}
			marginTop={hidden ? 0 : 1}
		>
			{children}
		</Box>
	)
}

// Tool call label: the tool name title-cased, then its most identifying
// argument — `Bash(ls -la)`, `Read(file.ts)`. A bare tool name in a transcript
// of forty calls says nothing about which one this was.
function formatToolCall(toolName: string, summary: string): string {
	const display = toolName.length > 0 ? toolName[0]?.toUpperCase() + toolName.slice(1) : toolName
	return summary.length > 0 ? `${display}(${summary})` : display
}

function hintForPhase(
	phase: LifecyclePhase,
	state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission',
	/** Whether there is a working session behind the picker to go back to. */
	canReturn = false,
): string {
	// Enter is absent because Enter grants nothing here, deliberately — see the
	// trust branch in the key handler above.
	if (phase === 'trust') return 'y trust this folder · n / esc exit'
	if (phase === 'resume') return '↑↓ navigate · enter resume · esc cancel'
	if (phase === 'edit') return 'Esc / ← older · → newer · enter fork and edit · q cancel'
	if (phase === 'probing') return 'discovering providers…'
	// Esc does two different things here depending on how the picker was reached,
	// so the hint says which. Naming Ctrl+C matters more here than anywhere else:
	// it is the screen a new user meets before they know the program has keys.
	if (phase === 'picker') {
		return canReturn
			? '↑↓ navigate · enter accept · esc keep current · Ctrl+C exit'
			: '↑↓ navigate · enter accept · esc or Ctrl+C exit'
	}
	if (phase === 'unhealthy') return 'Ctrl+C ×2 to exit'
	// Enter is absent because Enter decides nothing here, deliberately — see the
	// permission gate in the key handler above.
	if (state === 'awaiting-permission') return 'y approve · n / esc reject · a approve all'
	if (state !== 'idle') return 'enter steer · tab queue · esc interrupt'
	// The composer already points to /help. Keeping the complete key legend in
	// every idle frame made ordinary conversation read like a permanent setup
	// screen; only state-specific actions belong in the footer.
	return ''
}

function goalStatusLabel(goal: SessionGoal | null): string | null {
	if (!goal) return null
	switch (goal.phase) {
		case 'active':
			return 'Pursuing goal'
		case 'paused':
			return 'Goal paused (/goal resume)'
		case 'blocked':
			return 'Goal stalled (/goal resume)'
		case 'complete':
			return 'Goal achieved'
	}
}

function permissionModeDescription(mode: PermissionMode): string {
	switch (mode) {
		case 'prompt':
			return 'Ask before an undecided tool call runs'
		case 'auto':
			return 'Approve undecided calls unless a rule or safety gate refuses'
		case 'strict':
			return 'Refuse undecided calls; explicit allow rules still work'
	}
}

function permissionPickerNotice(session: AgentSession): string | undefined {
	const notices: string[] = []
	if (session.approvalLatched()) {
		notices.push('Approve all is active; applying any mode revokes it.')
	}
	const exempt = session.promptExemptTools()
	if (exempt.length > 0) notices.push(`Never prompted: ${exempt.join(', ')}.`)
	return notices.length > 0 ? notices.join(' ') : undefined
}

function reasoningEffortDescription(effort: ReasoningEffort | undefined): string {
	switch (effort) {
		case undefined:
			return 'Use the provider and model default'
		case 'none':
			return 'No deliberate reasoning where the model supports it'
		case 'minimal':
			return 'Fastest responses with minimal reasoning'
		case 'low':
			return 'Fast responses with light reasoning'
		case 'medium':
			return 'Balance speed and reasoning depth'
		case 'high':
			return 'Deeper reasoning for complex problems'
		case 'xhigh':
			return 'Very deep reasoning for hard problems'
		case 'max':
			return 'Maximum reasoning depth offered by this model'
		case 'ultra':
			return 'Highest host-level reasoning setting when supported'
	}
}

/**
 * The summary text, as collapsible detail under the compaction row.
 *
 * Collapsed rather than printed: a structured summary is long by design, and a
 * transcript that dumps it in full turns "I freed up context" into a wall taller
 * than the thing it replaced. Kept ON the row rather than dropped, because the
 * summary IS what the model will read from here on — an operator who wants to
 * check what survived has to be able to.
 */
function summaryDetail(summary: Message): readonly string[] {
	const text = typeof summary.content === 'string' ? summary.content : ''
	return text.length > 0 ? text.split('\n') : ['(the summary was empty)']
}
