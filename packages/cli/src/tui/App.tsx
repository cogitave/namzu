import { ConfigLoadError } from '../config/load.js'
import { type TurnGuardKey, type TurnGuards, resolveTurnGuards } from '../config/turn-guards.js'
import { TURN_LIMIT_FIELDS, turnLimitCommands } from './turn-limits-settings.js'
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

import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
	type BackgroundJob,
	type BackgroundJobOutput,
	type CostInfo,
	DEFAULT_MAX_GOAL_ROUNDS,
	DiskMessageFeedbackStore,
	type GoalRoundAuthority,
	GoalRoundLimitError,
	HostCommandRegistry,
	MONITOR_TOOL_NAME,
	type MemoryType,
	type Message,
	type MessageAttachment,
	type MessageId,
	type ReasoningEffort,
	type RuntimeContextMessageKind,
	SKILL_TOOL_NAME,
	type SessionGoal,
	SessionGoalActivation,
	type SessionId,
	StaleGoalError,
	TurnCancelled,
	type TurnId,
	asSessionId,
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
	generateSessionId,
	generateTurnId,
	isCompactionMessage,
	kernelHostCommands,
	resolveTriggerThreshold,
	resolveWorkflowLimits,
} from '@namzu/sdk'
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from 'ink'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
	type LivePeers,
	type PeerMail,
	buildPeerTools,
	openLivePeers,
	peerMailLabel,
	peerMailMessage,
} from '../integrations/peers/runtime.js'
import { discoverProviders } from '../integrations/providers/discover.js'
import {
	BackgroundJobsPanel,
	backgroundJobOutputPageSize,
	backgroundJobsPageSize,
	maxBackgroundJobTailOffset,
} from './BackgroundJobsPanel.js'
import { ProviderSetup } from './ProviderSetup.js'
import { TranscriptScreen } from './TranscriptScreen.js'

import {
	pinTrustedProjectPath,
	resolveTrustedProjectContext,
} from '../config/trusted-project-context.js'
import { visibleProjectInstructionPath } from '../context/project-path.js'
import { runtimeContextLabel } from '../context/runtime-message.js'
import { claimPalConversation, listPalConversations } from '../pals/conversations.js'
import type { Pal } from '../pals/store.js'
import {
	tuiPalDefinition,
	tuiPalEnvironment,
	tuiPalOwner,
	tuiPalPreferences,
} from '../pals/tui-session.js'
import type { PlanApprovalAnswer, PlanApprovalFn, PlanApprovalRequest } from '../plan/approval.js'

import { resolveComposerTriggers } from '../config/composer-triggers.js'
import { writeClipboardText } from '../integrations/clipboard/text.js'
import {
	type TerminalNotification,
	terminalNotificationEnabled,
	writeTerminalNotification,
} from '../integrations/notifications/terminal.js'
import {
	type CodexDeviceLogin,
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	type ProviderChoice,
	type ProviderId,
	type SubscriptionLogin,
	type SubscriptionProviderId,
	automaticChoice,
	automaticKind,
	beginCodexDeviceLogin,
	beginSubscriptionLogin,
	clearAllStoredCredentials,
	clearStoredCodexCredential,
	clearStoredGeminiApiKey as clearStoredGoogleApiKey,
	clearStoredSubscriptionCredential,
	credentialsPath,
	describeAutomaticChoice,
	googleApiKeyPath,
	parsePastedInput,
	primaryProvider,
	readStoredCodexCredential,
	readStoredGeminiApiKey as readStoredGoogleApiKey,
	readStoredSubscriptionCredential,
	signedInSubscriptionProviders,
	writePreferences,
	writeStoredGeminiApiKey as writeStoredGoogleApiKey,
} from '../integrations/providers/index.js'
import { generateTitle } from '../integrations/sessions/ai-title.js'
import { displayConversationTitle, typedTextOf } from '../integrations/sessions/display-title.js'
import { journalOf } from '../integrations/sessions/journal-trail.js'
import { generateRecap } from '../integrations/sessions/recap.js'
import {
	type CliSessions,
	ConversationIndexRefreshError,
	type RecentConversation,
	activeConversationTurn,
	archiveConversation,
	closableProviderPause,
	forkConversation,
	forkConversationBeforeUser,
	listArchived,
	listRecent,
	loadConversation,
	loadResumableConversation,
	openSessions,
	recordGeneratedTitle,
	requireWritableConversation,
	setTitle,
	startConversation,
	titleOf,
	titlesOf,
	unarchiveConversation,
} from '../integrations/sessions/store.js'
import {
	conversationMarkdown,
	writeConversationExport,
} from '../integrations/sessions/transcript-export.js'
import type { SideModel } from '../integrations/small-model/side-model.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import {
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
	type SubagentNarrationLine,
} from '../integrations/subagents/activity.js'
import type { Batch } from '../integrations/subagents/batches.js'
import { NARRATION_TOOL_NAME } from '../integrations/subagents/runtime.js'
import { agentsSlashCommand } from '../integrations/subagents/slash.js'
import { readFolderGrants } from '../integrations/trust/folder-grants.js'
import { isTrusted, trustDir } from '../integrations/trust/store.js'
import { checkUpdates } from '../integrations/updates.js'
import { completionNotice } from '../integrations/workflows/notice.js'
import {
	type WorkflowRunView,
	countAgents,
	isWorkflowRunAgent,
	runTokens,
} from '../integrations/workflows/view.js'
import { openManagedWorktrees, worktreeOpenHint } from '../integrations/worktrees/managed.js'
import {
	renderMemoryReport,
	renderMemorySaveResult,
	renderStoredMemorySection,
	renderTypedNoteResult,
} from '../memory/presentation.js'
import { appendMemoryWithStatus, readMemory } from '../memory/store.js'
import {
	BYPASS_CONSENT_BODY,
	BYPASS_CONSENT_TITLE,
	acknowledgeBypass,
	hasAcknowledgedBypass,
} from '../permissions/consent.js'
import {
	type ModeAvailability,
	type PermissionMode,
	autoAvailable as autoModeAvailable,
	nextCycleMode,
	permissionModeDescription,
	permissionModeLabel,
} from '../permissions/mode.js'
import { type SessionAllow, allowsFor, sameAllow } from '../permissions/session-allow.js'
import { schedulePaths } from '../schedule/paths.js'
import {
	SKILL_CREATOR_SKILL,
	type SaveSkillAnswer,
	type SaveSkillRequest,
	buildSaveSkillTool,
	learnSkillPrompt,
	newSkillPrompt,
} from '../skills/save.js'
import {
	NO_SKILLS_FOUND,
	composeSkillsPrompt,
	discoverSkills,
	loadSkillBody,
	renderSkillRoster,
	skillTierLabel,
} from '../skills/store.js'
import { type UserCommand, discoverUserCommands } from '../user-commands/store.js'
import {
	AGENT_RAIL_WINDOW,
	AgentCockpit,
	type AgentCockpitFocus,
	AgentNarrationBand,
	AgentTaskPanel,
	AgentTranscript,
	AgentView,
	type RailWorkflow,
	agentCockpitIsWide,
	agentPhasePageSize,
	agentPickerPageSize,
	agentTranscriptPageSize,
	agentViewPageRows,
	agentWorkflowPageSize,
	agentWorkflows,
	cockpitEntryFocus,
	maxAgentTranscriptTailOffset,
	maxAgentViewTailOffset,
	railActionFor,
	railAgents,
	railHint,
	railNextEviction,
	railShowsMain,
	railWorkflowActionFor,
	railWorkflows,
	runRailWorkflow,
	settledWorkflows,
} from './AgentExplorer.js'
import { BackgroundAgentRows } from './BackgroundAgentRows.js'
import { BrandHeader } from './BrandHeader.js'
import { checklistProgress } from './Checklist.js'
import { ChoicePicker, type ChoicePickerOption } from './ChoicePicker.js'
import {
	Composer,
	type ComposerDraft,
	type ComposerSubmitMode,
	type ComposerTriggerSettings,
	type SubmitMeta,
	suggestionWindowSize,
} from './Composer.js'
import { ComposerFrame } from './ComposerFrame.js'
import { CopyPicker } from './CopyPicker.js'
import { EffortSlider, effortSliderLayout } from './EffortSlider.js'
import { type ActiveTool, LiveActivity, formatElapsed } from './LiveActivity.js'
import { PendingInputPanel, pendingInputPanelRows } from './PendingInputPanel.js'
import { type PermissionChoice, PermissionOverlay, permissionAnswers } from './PermissionOverlay.js'
import { Picker } from './Picker.js'
import { PlanApprovalOverlay } from './PlanApprovalOverlay.js'
import { QuestionDialog } from './QuestionDialog.js'
import { ResumePicker } from './ResumePicker.js'
import { RewindPicker } from './RewindPicker.js'
import { SaveSkillOverlay } from './SaveSkillOverlay.js'
import {
	type ScheduleReviewAnswer,
	ScheduleReviewOverlay,
	type ScheduleReviewRequest,
} from './ScheduleReviewOverlay.js'
import { StatusBar } from './StatusBar.js'
import { TaskList, type TaskListItem, taskListRows } from './TaskList.js'
import { TextPrompt } from './TextPrompt.js'
import { ThemeSample } from './ThemeSample.js'
import { Transcript, messageCollapses } from './Transcript.js'
import { TranscriptScrollView } from './TranscriptScrollView.js'
import { TrustPrompt } from './TrustPrompt.js'
import { ViewportBound } from './ViewportBound.js'
import { stopAllStep, stoppableBackgroundAgents } from './agent-stop-all.js'
import {
	childMessageNotice,
	childMessageRow,
	failureReason,
	settleLine,
	workflowAgentProgress,
	workflowNotice,
} from './agent-transcript-rows.js'
import {
	type AgentEvent,
	type AgentSession,
	type PermissionDecision,
	type PermissionRequest,
	type QuestionAnswer,
	type QuestionFn,
	type ScreenPermissionFn,
	type ScreenPermissionRequest,
	type SessionScope,
	type UserQuestion,
	builtinToolPresenter,
	createAgentSession,
	describeProviderModels,
	probeAgentSession,
} from './agent.js'
import {
	backgroundWaitLine,
	isRunning,
	liveGroups,
	pendingBackgroundAgents,
	stoppedByUserNote,
} from './background-agents.js'
import {
	describeCapabilityNotice,
	describeHistoryRepairNotice,
	withDebugDetail,
} from './capability-notice.js'
import {
	choicePickerWindowSize,
	filterChoiceOptions,
	moveChoiceSelection,
} from './choice-selection.js'
import { keepRecentRows } from './compact-transcript.js'
import {
	COMPACTED_HINT,
	COMPACTING_LABEL,
	COMPACT_NOT_SAVED_TEXT,
	COMPACT_RESULT_HINT,
	COMPACT_RESULT_TEXT,
	NOTHING_TO_COMPACT_TEXT,
	compactionSummaryLines,
} from './compaction-rows.js'
import { approvalIsDeliberate } from './consent-timing.js'
import { CONTEXT_NOTICE_KEY, contextMeter, contextNotice } from './context-meter.js'
import { buildContextRow } from './context-usage.js'
import { assistantTranscriptTexts } from './conversation-history.js'
import { type CopyResponseTarget, copyTargetsForResponse } from './copy-targets.js'
import { type EditablePrompt, editablePrompts } from './edit-prompts.js'
import type { TuiExitSummary } from './exit-summary.js'
import { ExternalEditorError, editDraftInExternalEditor } from './external-editor.js'
import {
	HYPERMODE,
	HYPERMODE_ROW_LABEL,
	HYPERMODE_SUMMARY,
	ORCHESTRATE_ALIAS_NOTICE,
	hypermodeOffMessage,
	hypermodeOnMessage,
} from './hypermode.js'
import { jobExitRow, monitorEndRow } from './job-exit-row.js'
import { choosesModel, launchPreferences } from './launch-settings.js'
import { checklistInView, liveWindow, settledBeforeStreaming } from './live-window.js'
import {
	describeAllCredentialsLogout,
	describeCodexDeviceLoginStart,
	describeLoginOutcome,
	describeLoginStart,
	describeProviderLogout,
} from './login-prompt.js'
import {
	AUTO_ALREADY_ON,
	AUTO_MODEL_LABEL,
	AUTO_ON_NOTICE,
	AUTO_TURNED_OFF_SUFFIX,
	autoModelLabel,
	autoRefusal,
	isAutoQuery,
	parseModelSelectionIntent,
	resolveModelSelectionIntent,
} from './model-selection-intent.js'
import {
	type ModelSwitchOutcome,
	type ModelSwitchRequest,
	resolveModelSwitch,
} from './model-switch.js'
import { reducedMotion, useReducedMotion } from './motion.js'
import { nextTask, nextTaskLine } from './next-task.js'
import { isRepeatedNotice } from './notices.js'
import {
	type TerminalPerCallReview,
	appendTypedReason,
	createTerminalPerCallReview,
	noWithReason,
	plainNo,
} from './per-call-review.js'
import { type AskCount, AskQueue, CLOSED_QUESTION } from './permission-asks.js'
import { displayPath, formatSize, homePath, plural, productName } from './person-terms.js'
import { StartupRefusal, explainFailure, isMachineError } from './plain-failure.js'
import {
	type ProviderWaitNotice,
	debugRequested,
	describePlainInterruption,
	describeProviderWait,
} from './plain-interruption.js'
import {
	emptyPluginReport,
	pluginDetails,
	pluginOption,
	pluginStartupState,
} from './plugin-view.js'
import { selectPrimaryProvider } from './provider-selection.js'
import { needsQuestionDialog } from './question-dialog.js'
import {
	queuedToolRow,
	withQueuedRow,
	withStartedRow,
	withTakenOverRow,
	withoutQueuedRow,
} from './queued-calls.js'
import {
	REWIND_COUNT_BUDGET_MS,
	type RewindOption,
	type RewindRow,
	type RewindState,
	buildRewindRows,
	countRewindRows,
	openRewind,
	optionsFor,
	rewindKey,
} from './rewind.js'
import { type ScheduleIntegration, createScheduleIntegration } from './schedule/integration.js'
import {
	SourceDeliveryView,
	deliveryLevel,
	sourceConversationBinding,
	sourceDeliveryLine,
	sourceDeliveryReadError,
} from './schedule/source-deliveries.js'
import { SHELL_LIVE_LINES, type ShellOutput } from './shell-cell.js'
import {
	SUGGESTIONS_STOPPED_NOTICE,
	type TurnActivity,
	createTurnActivity,
	judgeSkillSuggestion,
	observeTurnEvent,
	skillSuggestionNotice,
} from './skills/learning.js'
import { setSkillSuggestions } from './skills/suggest-setting.js'
import {
	FRESH_LEDGER,
	admitSuggestion,
	readSuggestionLedger,
	writeSuggestionLedger,
} from './skills/suggestion-ledger.js'
import { setSpinnerTips } from './spinner-tips-setting.js'
import { sendWithRebuiltHistory } from './stale-history-retry.js'
import {
	CLOSING_GLYPH,
	CONTINUATION_GLYPH,
	SYSTEM_ROW_GLYPH,
	type SystemLevel,
	clipboardSentNotice,
	endWord,
	goalRoundHeadline,
	interruptionRow,
	systemRowStyle,
} from './system-rows.js'
import {
	type TaskOperation,
	applyTaskOperation,
	removeTask,
	taskOperationFor,
	taskReportChecklist,
	upsertTask,
} from './task-activity.js'
import { eraseLastChoiceGrapheme } from './terminal-choice-text.js'
import { describeReducedMotion, saveReducedMotion, saveTheme } from './theme-command.js'
import { THEME_CHOICES, type ThemeSetting } from './theme-palettes.js'
import {
	ThemeEpochContext,
	savedThemeSetting,
	setThemePreview,
	shownTheme,
	useThemeSubscription,
} from './theme-store.js'
import type { TipHistoryStore } from './tip-history.js'
import { triggerContextTexts, triggerEffort } from './triggers/context-text.js'
import { STEERED_NOT_APPLIED_REASON, notAppliedLine, transcriptTagLine } from './triggers/copy.js'
import { type TriggerContext, unavailable as triggerUnavailable } from './triggers/detect.js'
import {
	BUILTIN_TRIGGERS,
	type TriggerId,
	compileRegistry,
	triggerDefinition,
} from './triggers/registry.js'
import { describeComposerTriggers, setComposerTriggers } from './triggers/setting.js'
import { typedInputOf } from './typed-input.js'
import { formatCompactCount } from './units.js'
import { useSpinnerTip } from './use-spinner-tip.js'
import { type WebActivity, webCallTitle, webLiveStatus } from './web-activity.js'
import { withWorkflowRuns } from './workflow-runs.js'

import type { BrowserControl } from '../browser/control.js'
import { renderCheckpoints, renderRestore, renderRestoreNote } from '../checkpoints/store.js'
import { IDLE_COMPACTION_NOTICE } from '../integrations/compaction/idle-compaction.js'
import { ApprovalNotifier } from '../integrations/notifications/approval.js'
import { IdleNotifier } from '../integrations/notifications/idle.js'
import { agentViewCommandClass } from './agent-view-commands.js'
import { AwayRecap } from './away-recap.js'
import { browserSiteNotes, describeBrowserHandoff, runBrowserSlash } from './browser-notices.js'
import type { QueuedHintCount } from './composer-hints.js'
import type { ProposedChange } from './diff-rows.js'
import { EXIT_HINT_MS } from './exit-hint.js'
import { mergeGroupRows } from './group-rows.js'
import { expandFileMentions, listMentionableFiles } from './mentions.js'
import { openInBrowser } from './open-browser.js'
import { PauseClock } from './pause-clock.js'
import {
	type WithheldCall,
	buildPermissionReview,
	buildPermissionSummary,
	permissionReviewPageRows,
	permissionReviewRefusal,
	permissionReviewRows,
} from './permission-review.js'
import { examplePlaceholder, frequentlyModifiedFile } from './placeholder-examples.js'
import type { FoldOp } from './read-search-group.js'
import {
	describeRecapSetting,
	recapEnabled,
	recapWaitMs,
	setRecapSetting,
} from './recap-setting.js'
import { recapRows, recapTurns } from './recap-turns.js'
import {
	type RestoreOptions,
	agentCompletionRows,
	agentLaunchRow,
	createRestoredTurnWriter,
	numberDetailRows,
	trailFromRecords,
	withSavedAgentRows,
	workflowClosingRow,
} from './restored-rows.js'
import { moveSelection } from './selection-window.js'
import {
	describeShellEscape,
	describeShellEscapeForModel,
	runShellEscape,
	shellEscapeCommand,
} from './shell-escape.js'
import {
	type CommandPickerEntry,
	type SlashContext,
	baseBranchReviewPrompt,
	commandPickerDescription,
	commitReviewPrompt,
	hostCommandNames,
	kernelCommandDescriptors,
	mergeHostCommands,
	parseSlash,
	renderAgents,
	renderOutcome,
	reviewPrompt,
	runSlash,
} from './slashCommands.js'
import { StatusLineRows } from './status-line/StatusLineRows.js'
import { useStatusLine } from './status-line/useStatusLine.js'
import { splitCompleteBlocks, splitSafeCut } from './stream-blocks.js'
import { terminalDisplayText } from './terminal-display.js'
import { terminalFocus, useTerminalFocused } from './terminal-focus.js'
import { terminalSupportsHyperlinks } from './terminal-hyperlinks.js'
import {
	RESET_TERMINAL_TITLE_SEQUENCE,
	setTerminalTitleSequence,
	terminalTitleEnabled,
	terminalTitleText,
	titleAnimates,
	underMultiplexer,
} from './terminal-title.js'
import { theme, tokenColor } from './theme.js'
import { useTitleFrame } from './title-frame.js'
import { type ToolRow, formatToolCall, toolEndRows } from './tool-end-rows.js'
import {
	PAUSED_TURN_LINES,
	describeTurnStop,
	handoffContinuationNote,
} from './turn-interruption.js'
import type { TranscriptMessage, TuiContext } from './types.js'
import { updateAmbient } from './update-notice.js'
import { useIdleCompaction } from './use-idle-compaction.js'
import { usePrStatus } from './use-pr-status.js'
import { useSelectionIndex } from './use-selection-index.js'
import { useNotifications } from './useNotifications.js'
import { useReadSearchGroup } from './useReadSearchGroup.js'
import { renderWorkspaceDiff, workspaceDiff } from './workspace-diff.js'
import {
	type ReviewCommit,
	listReviewBranches,
	listReviewCommits,
	reviewMergeBase,
} from './workspace-review.js'

/** How long `/exit` waits for the session to close before leaving anyway. */
const SESSION_CLOSE_ON_EXIT_MS = 5_000

export interface AppProps {
	readonly ctx: TuiContext
	readonly onExitSummary?: (summary: TuiExitSummary) => void
	/** Test/embedding seam; the normal TUI uses VISUAL/EDITOR on the host. */
	readonly externalEditor?: ExternalEditorAdapter
	/**
	 * Where the launcher finds how to leave on a termination signal
	 * (`termination.ts`): the App puts there "stop the running turn, then leave
	 * as `/exit` does". The conversation's lease is already given back by then.
	 */
	readonly terminationExit?: { current: (() => void) | null }
	/**
	 * The launcher turns this on: an empty first prompt suggests an example
	 * (`Try "fix lint errors"`). Off by default so the many fixtures that wait
	 * for the plain placeholder keep waiting for it.
	 */
	readonly examplePrompts?: boolean
	/** Where the queued-messages hint's count is kept; the launcher gives the user-level file. */
	readonly queuedHintCount?: QueuedHintCount
	/** Where spinner tips are remembered between launches; absent shows no tips (tests, embeds). */
	readonly tipHistory?: TipHistoryStore
}

type PendingPermission = ScreenPermissionRequest & {
	readonly review: string
	readonly summary: ReturnType<typeof buildPermissionSummary>
	/** `site rule: <origin> → <level> · profile <p> · <engine>`, one per browser call. */
	readonly siteNotes?: readonly string[]
	/** Calls whose input the review leaves partly out; approving them is one-time only. */
	readonly withheld: readonly WithheldCall[]
	/** The request the SDK holds and will execute: what the person approves is this object. */
	readonly source: ScreenPermissionRequest
	/** Hash of the true batch when it was shown; checked again when it is approved. */
	readonly envelopeHash: string
}

export type ExternalEditorAdapter = (request: {
	readonly seed: string
	readonly cwd: string
	readonly signal: AbortSignal
}) => Promise<string>

type LifecyclePhase =
	| 'trust'
	| 'probing'
	| 'picker'
	| 'ready'
	| 'unhealthy'
	| 'resume'
	| 'unarchive'
	| 'edit'
type ConversationMutation = 'fork' | 'edit' | 'new' | 'archive' | 'materialize'

interface PendingModelSwitch {
	readonly turnToken: object
	readonly generation: number
	readonly sessionId: SessionId | undefined
	readonly ownerSession: AgentSession
	readonly controller: AbortController
	readonly signal: AbortSignal
	selection?: ProviderChoice & { readonly model: string }
}
type AgentSurface =
	| {
			readonly kind: 'cockpit'
			readonly selectedPhaseId: string
			readonly selectedId: string
			readonly focus: AgentCockpitFocus
			/** Opened from a workflow row on the rail: Esc goes back to that row. */
			readonly railReturn?: string
	  }
	| {
			readonly kind: 'transcript'
			readonly selectedId: string
			readonly selectedPhaseId: string
			readonly returnFocus: AgentCockpitFocus
			readonly tailOffset: number
			readonly composing?: boolean
			/** Opened from the agents rail: Esc goes back to the rail, not the cockpit. */
			readonly fromRail?: boolean
			/** The workflow row the cockpit this came from was opened from. */
			readonly railReturn?: string
	  }
type DirectChildNotice = {
	readonly context: string
	readonly label: string
	readonly kind: RuntimeContextMessageKind
}
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
	readonly kind:
		| 'conversation-title'
		| 'export-file'
		| 'user-question'
		| 'goal-create'
		| 'goal-edit'
		| 'turn-limit'
	readonly limitKey?: TurnGuardKey
	readonly title: string
	readonly placeholder: string
	readonly emptyNotice: string
	readonly initialValue: string
	readonly sessionId: SessionId
}
type ConversationExportDestination =
	| { readonly kind: 'clipboard' }
	| { readonly kind: 'file'; readonly path: string }
/** The value a question row carries: an option id, or the free-text escape. */
const FREE_TEXT_ANSWER = '__free_text__'
/**
 * The footer's shell pill as a stop in the rail's focus order: before `main`
 * and the agents: the shells pill comes before the agents.
 * It cannot collide with a view id or a `workflow:` focus id.
 */
const SHELLS_FOCUS = 'shells'
/** The stop-all chord's armed notice; the second press removes it. */
const STOP_ALL_CONFIRM_KEY = 'kill-agents-confirm'

type PluginChoiceState = ({ readonly kind: 'plugin' } | { readonly kind: 'plugin-action' }) & {
	readonly title: string
	readonly notice?: string
	readonly owner: AgentSession
	readonly pluginName?: string
	readonly busy?: boolean
	readonly values: readonly string[]
	readonly options: readonly ChoicePickerOption[]
}

type ChoicePickerState = {
	readonly back?: ChoicePickerState
	readonly request?: object
} & (
	| PluginChoiceState
	| {
			readonly kind: 'resume-goal'
			readonly title: string
			readonly notice: string
			readonly sessionId: string
			readonly values: readonly ('resume' | 'later')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			/**
			 * A question the model put to the operator. `values` are option ids
			 * plus `FREE_TEXT_ANSWER` when the model allowed an answer in the
			 * operator's own words; the resolver lives in a ref, like a
			 * permission's, because a picker is state and a promise is not.
			 */
			readonly kind: 'user-question'
			readonly title: string
			readonly notice?: string
			readonly values: readonly string[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'command'
			readonly title: string
			readonly notice?: string
			readonly values: readonly CommandPickerEntry[]
			readonly options: readonly ChoicePickerOption[]
			readonly windowSize: number
	  }
	| {
			/**
			 * `/agents batches`. `values` holds `'loading'` alone while the index
			 * read is still in flight — its lone option carries a `disabledReason`,
			 * so Enter cannot select it — and is replaced with the resolved rows
			 * once it settles; never a mix of the two.
			 */
			readonly kind: 'agent-batches'
			readonly title: string
			readonly notice?: string
			readonly values: readonly (Batch | 'loading')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			/** `/workflows`: the runs of this conversation; `values` are their run ids. */
			readonly kind: 'workflow-runs'
			readonly title: string
			readonly notice?: string
			/** `1 running, 2 finished`, counted when the list opened. */
			readonly subtitle?: string
			readonly values: readonly string[]
			readonly options: readonly ChoicePickerOption[]
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
			readonly values: readonly (PermissionMode | 'more' | 'rules')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			/** The first switch into bypass: asked once, then remembered. */
			readonly kind: 'bypass-consent'
			readonly title: string
			readonly notice?: string
			/** Whether the switch was asked for by name (and so gets a reply line). */
			readonly announce: boolean
			readonly values: readonly ('decline' | 'accept')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			readonly kind: 'reasoning-effort'
			readonly title: string
			readonly notice?: string
			/** The published model whose paused queue this follow-up may configure. */
			readonly selectedSession?: AgentSession
			/** The last entry is the hypermode row, below a rule; never a `ReasoningEffort`. */
			readonly values: readonly (ReasoningEffort | undefined | 'hypermode')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			/**
			 * A command that acts on the conversation, typed while an agent is
			 * viewed: asks once, then runs it against the conversation.
			 */
			readonly kind: 'agent-view-command'
			readonly title: string
			readonly notice?: string
			readonly line: string
			readonly values: readonly ('cancel' | 'run')[]
			readonly options: readonly ChoicePickerOption[]
	  }
	| {
			/** `/theme`: `values` are the settings, in the order of the rows. */
			readonly kind: 'theme'
			readonly title: string
			readonly notice?: string
			readonly values: readonly ThemeSetting[]
			readonly options: readonly ChoicePickerOption[]
			readonly windowSize: number
	  }
	| {
			readonly kind: 'feedback-rating'
			readonly title: string
			readonly notice?: string
			readonly messageId: string
			readonly sessionId: SessionId
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
			readonly values: readonly (SubscriptionProviderId | 'google')[]
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
)

/**
 * The streaming assistant bubble, carried across events within one turn.
 *
 * `text` is everything the model has said and is what gets persisted;
 * `pending` is the part not yet on screen, held until it forms a whole block.
 * The two are separate because they answer different questions — what was
 * said, and what has been shown — and conflating them is how a reply gets
 * saved with a paragraph the operator never saw, or shown twice.
 */
/**
 * How long held reply text may wait before a sentence of it is shown.
 *
 * Blocks are released as they complete (`splitCompleteBlocks`), which keeps a
 * fast reply landing a paragraph at a time. A slow one — a long paragraph
 * arriving over twenty seconds — completes no block until its last character
 * and was invisible for its whole length. Past this interval the pending
 * text is released to its last safe cut instead (`splitSafeCut`): a sentence
 * or a line, never a half-word, never inside a fence. Long enough that a
 * fast stream never reaches it; short enough that a slow one reads as
 * writing rather than as silence.
 */
const STREAM_RELEASE_MS = 250

/**
 * How long a batch of delegated agents stays still before its launch receipt
 * is written. Agents of one response are begun within a few milliseconds of
 * one another; this is the margin that keeps them on one receipt.
 */
const RECEIPT_SETTLE_MS = 250

/** How a turn ended, as the transcript and notifications describe it. */
type ConversationTurnOutcome = 'completed' | 'stopped' | 'failed' | 'cancelled'

type StreamState = {
	lastUsage?: Extract<AgentEvent, { kind: 'usage' }>
	assistantId: string | null
	/** Provider message boundary, independent of the parent session. */
	sourceMessageId?: string
	sourceTextPartId?: string
	text: string
	/** Where the reply being streamed began in `text`, so a restarted stream can cut it back. */
	messageTextStart?: number
	/** Exact provider-visible conversation state returned by the settled kernel run. */
	conversationMessages?: readonly Message[]
	pending?: string
	/**
	 * When held text was last released to the screen, and the timer that
	 * releases it if the stream goes quiet. See `STREAM_RELEASE_MS`.
	 */
	releasedAt?: number
	releaseTimer?: ReturnType<typeof setTimeout>
	/** Only a normal turn end makes this text the next `/copy` target. */
	completed: boolean
	/** Exact durable turn outcome; notification wording is intentionally coarser. */
	outcome: ConversationTurnOutcome | null
	/** Durable conversation whose turn evidence this stream writes. */
	sessionId: SessionId | null
	/** More precise queue copy when a resumable SDK turn stopped. */
	queuePauseOutcome?: QueuePauseOutcome
	/** Terminal notice earned by this turn, or null when it was interrupted. */
	notification: TerminalNotification | null
	/** Names this stream's task blocks, so one turn never extends another's. */
	taskBlockKey?: string
	/** When this turn began, for the closing line of a turn that delegated. */
	startedAt?: number
	/** What the pause clock read when this turn began, so waiting for the person is left out of its time. */
	pausedAtStart?: number
	/**
	 * Output tokens the provider has reported for this turn, and characters of
	 * reply and reasoning streamed since that report. Together they are the
	 * `↓ 1.1k tokens` on the Working row: the provider's count where it has
	 * given one, a characters-over-four estimate for what has arrived since.
	 */
	reportedOutputTokens?: number
	streamedChars?: number
	/**
	 * What this turn did, for the proposal to save it as a skill. Only an
	 * operator's own prompt carries it: a goal round and a resumed turn do not.
	 */
	learning?: TurnActivity
	/** Sent by `/skills save` or `/skills new`: already making a skill. */
	skillFlow?: boolean
	/** The permission mode the turn started in. */
	startedInPlanMode?: boolean
	/** After-turn composer triggers bound to this turn: run once when it ends, if it earned them. */
	followUps?: TriggerId[]
	/** namzu's words for this turn's triggers: request-only context, read at every iteration. */
	contextTexts?: string[]
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

/** The first thing a person typed in a conversation, short enough for a title; `undefined` when none. */
function firstTypedPrompt(messages: readonly Message[]): string | undefined {
	for (const message of messages) {
		if (message.role !== 'user' || message.source) continue
		const text = typedTextOf(message.content).text.replace(/\s+/g, ' ').trim()
		if (text.length > 0) return text.length > 60 ? `${text.slice(0, 59)}…` : text
	}
	return undefined
}

/** Exact operator-authored prompts that belong in terminal input history. */
export function promptHistoryFromConversation(messages: readonly Message[]): readonly string[] {
	return messages.flatMap((message) =>
		message.role === 'user' && !message.source && message.content.trim().length > 0
			? [message.content]
			: [],
	)
}

/**
 * Build the transcript projection of exact model-visible history.
 *
 * Tool calls come back as the rows the live run drew for them, a turn closes
 * with its "Worked for" line, and a turn the operator interrupted says so.
 * `restore.trail` (the journal of the conversation, see `trailFromRecords`)
 * supplies the typed facts, timings and turn boundaries; without it the rows
 * are drawn from the saved messages alone.
 */
export function projectConversation(
	messages: readonly Message[],
	nextId: () => string,
	readableUserTexts: readonly string[] = [],
	restore?: Partial<RestoreOptions>,
): readonly TranscriptMessage[] {
	let userOrdinal = 0
	const writer = createRestoredTurnWriter(messages, nextId, {
		presenter: restore?.presenter ?? builtinToolPresenter(),
		...(restore?.trail ? { trail: restore.trail } : {}),
		...(restore?.cwd ? { cwd: restore.cwd } : {}),
	})
	const out: TranscriptMessage[] = []
	for (const message of messages) {
		out.push(...writer.enter(message))
		const rows = projectMessage(message)
		out.push(...rows)
		if (message.role === 'assistant') {
			const tools = writer.toolRows(message)
			out.push(...tools.rows)
			const last = out.at(-1)
			if (tools.launchedIn && last) out[out.length - 1] = { ...last, agentTurnId: tools.launchedIn }
		}
	}
	out.push(...writer.finish())
	return numberDetailRows(mergeGroupRows(out))

	function projectMessage(message: Message): readonly TranscriptMessage[] {
		if (message.role === 'user') {
			if (message.source?.type === 'project-instructions') {
				return [
					{
						id: nextId(),
						role: 'system',
						content: 'Project instructions',
						glyph: SYSTEM_ROW_GLYPH,
						glyphColor: systemRowStyle('notice').color,
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
						content: goalRoundHeadline(message.source.round, message.source.maxGoalRounds),
						glyph: SYSTEM_ROW_GLYPH,
						glyphColor: systemRowStyle('notice').color,
					},
					{
						id: nextId(),
						role: 'system',
						content: message.source.objective,
						glyph: CONTINUATION_GLYPH,
						glyphColor: tokenColor('text.muted'),
					},
				]
			}
			// A hidden reminder is for the model; the live transcript never showed it.
			if (message.source?.type === 'runtime-context' && message.source.kind === 'reminder') {
				return []
			}
			if (message.source?.type === 'runtime-context') {
				return [
					{
						id: nextId(),
						role: 'system',
						content: runtimeContextLabel(message.source.kind),
						glyph: SYSTEM_ROW_GLYPH,
						glyphColor: systemRowStyle('notice').color,
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
			return assistantTranscriptTexts(message).map<TranscriptMessage>((content) => ({
				id: nextId(),
				role: 'assistant',
				content,
			}))
		}
		if (message.role === 'system' && isCompactionMessage(message.content)) {
			return [
				{
					id: nextId(),
					role: 'system',
					content: 'Conversation compacted',
					glyph: CLOSING_GLYPH,
					glyphColor: tokenColor('text.muted'),
					meta: COMPACTED_HINT,
					activity: 'summary',
					detail: summaryDetail(message),
				},
			]
		}
		return []
	}
}

/** A running tool tracked internally: the live row's fields plus what we need
 *  to commit it on completion (the tool name for matching, the call-time diff). */
type RunningTool = ActiveTool & {
	readonly activity?: 'exploration'
	/** A call that only looks: drawn in the counted line, not in the live tool list. */
	readonly fold?: FoldOp
	readonly taskId?: string
	readonly turnId?: string
	readonly toolName: string
	readonly detail?: readonly string[]
	/** A web search or fetch, named by its query or address. */
	readonly web?: WebActivity
	/** A shell call's full command; its presence is what draws the call as a command cell. */
	readonly command?: string
	/** What an edit or write asked for, drawn dimmed if the person refuses it. */
	readonly proposed?: ProposedChange
	/** The last few output lines the call has reported, oldest first. */
	readonly tail?: readonly string[]
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
			/** Composed by `/skills save` or `/skills new`; see `StreamState.skillFlow`. */
			readonly skillFlow?: true
			/** Only an operator-composed message can be returned to the composer. */
			readonly recallable?: true
			/** The typed command when a slash action expanded it into `text` for the model. */
			readonly recallText?: string
			/**
			 * Composer triggers armed when the operator sent it (`./triggers/`).
			 * Only the composer's own submit sets this; see `SubmitMeta`.
			 */
			readonly triggers?: readonly TriggerId[]
	  }
	| {
			readonly kind: 'peer'
			readonly text: string
			readonly mail: PeerMail
			readonly generation: number
	  }
	| {
			/**
			 * What ended while nobody was talking to the model: a workflow run, a
			 * background command. The text is built when the turn is admitted,
			 * from what is still undelivered then, so it never repeats a notice a
			 * running turn already took.
			 */
			readonly kind: 'notice'
			readonly text: string
			readonly generation: number
	  }
	| {
			readonly kind: 'goal'
			readonly text: string
			readonly goalRound: GoalRoundAuthority
			readonly generation: number
	  }

type HumanQueuedPrompt = Extract<QueuedPrompt, { readonly kind: 'human' }>

function isRecallableHumanPrompt(prompt: QueuedPrompt | undefined): prompt is HumanQueuedPrompt {
	return prompt?.kind === 'human' && prompt.recallable === true
}

interface LiveInput {
	readonly prompt: HumanQueuedPrompt
	readonly message: Message
	readonly attachedFiles: number
	/** Queue identities present at acceptance; recalls may remove any of them. */
	readonly queuedBefore: readonly QueuedPrompt[]
}

interface ActiveTurnInbox {
	notify(): void
	accept(input: LiveInput): boolean
	drain(): Message[]
	waitForInbound(signal: AbortSignal): Promise<void>
	close(): readonly LiveInput[]
}

/** Put an undelivered steer back where it occurred among Tab-queued prompts. */
function mergeUndeliveredLiveInput(
	queued: readonly QueuedPrompt[],
	undelivered: readonly LiveInput[],
): readonly QueuedPrompt[] {
	const merged = [...queued]
	let lastInsertedIndex = -1
	for (const input of undelivered) {
		let lastPredecessorIndex = -1
		for (const predecessor of input.queuedBefore)
			lastPredecessorIndex = Math.max(lastPredecessorIndex, merged.indexOf(predecessor))
		const index = Math.max(lastPredecessorIndex, lastInsertedIndex) + 1
		merged.splice(index, 0, input.prompt)
		lastInsertedIndex = index
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
	if (live) parts.push('sent while working')
	return parts.length > 0 ? parts.join(' · ') : undefined
}
type QueuePauseOutcome = 'failed' | 'stopped' | 'paused'

interface QueuePause {
	readonly outcome: QueuePauseOutcome
	/** Esc pauses the queue so the next explicit Enter can run before it. */
	readonly source?: 'operator-interrupt'
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
 * Rows the scroll view leaves to the composer frame, the footer and the shell line;
 * the transcript window takes the rest of the terminal.
 */
const SCROLL_VIEW_RESERVED_ROWS = 9

/**
 * Rows the live region occupies apart from the transcript window: the activity
 * line, the composer frame and its padding, the status bar.
 *
 * Counted generously because under-counting lets the redrawable transcript
 * window grow until the renderer gives up on incremental repaint. Over-counting
 * merely settles one more row into native terminal scrollback.
 */
const LIVE_FURNITURE_ROWS = 10

type JobSurface = {
	readonly ownerSession: AgentSession
	readonly selectedJobId: string | null
	readonly detailJobId: string | null
	readonly tailOffset: number
	readonly busyJobId?: string
	readonly notice?: string
}

const defaultExternalEditor: ExternalEditorAdapter = ({ seed, cwd, signal }) =>
	editDraftInExternalEditor(seed, { cwd, signal })

/**
 * The App, drawn inside the theme epoch: a theme change redraws this component,
 * and the epoch it hands down is what makes a memoised row repaint.
 */
export function App(props: AppProps) {
	const epoch = useThemeSubscription()
	return (
		<ThemeEpochContext.Provider value={epoch}>
			<AppBody {...props} />
		</ThemeEpochContext.Provider>
	)
}

function AppBody({
	ctx: initialCtx,
	onExitSummary,
	externalEditor = defaultExternalEditor,
	terminationExit,
	examplePrompts = false,
	queuedHintCount,
	tipHistory,
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
	const terminal = useWindowSize()
	const hyperlinks = terminalSupportsHyperlinks(process.env, stdout.isTTY === true)
	/**
	 * The last assistant message id the turn reported, for `/feedback`.
	 *
	 * A ref rather than state: nothing renders it, and making it state would
	 * re-render the transcript on every delta — the exact cost the `pending`
	 * buffering two hundred lines down exists to avoid.
	 */
	const lastAssistantMessage = useRef<{
		messageId: string
		sessionId: SessionId
	} | null>(null)
	/**
	 * The latest assistant text available to `/copy`, with what proves it.
	 *
	 * Separate from `lastAssistantMessage`: feedback needs ids as soon as a
	 * streamed message exists, while copying must keep the previous finished
	 * answer until the current turn reaches a normal `done`. A budget stop,
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
	/** The detailed transcript screen (Ctrl+O) is up in place of the composer. */
	const [transcriptScreen, setTranscriptScreen] = useState(false)
	/** The scrollable transcript, opened by paging up from the composer. */
	const [scrollOpen, setScrollOpen] = useState(false)
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
	const palDefinitionRef = useRef<Pal | null>(null)
	const palRouteSessionRef = useRef<string | null>(null)
	const palDefaultPreferencesRef = useRef<Preferences | null>(null)
	const [history, setHistory] = useState<readonly string[]>([])
	const [state, setState] = useState<'idle' | 'thinking' | 'tool' | 'awaiting-permission'>('idle')
	/** For the scheduler integration's loop timer, which reads it outside render. */
	const stateRef = useRef(state)
	stateRef.current = state
	const [phase, setPhase] = useState<LifecyclePhase>('probing')
	// True when the sentence that stopped startup already says what to do next, so
	// the screen adds no second line of advice under it.
	const [startupExplained, setStartupExplained] = useState(false)
	const phaseRef = useRef(phase)
	phaseRef.current = phase
	const [session, setSession] = useState<AgentSession | null>(null)
	// Once a usable session publishes the transcript, temporary lifecycle
	// surfaces must never take ownership of it. Ink's <Static> remembers which
	// rows it already handed to terminal scrollback only for the lifetime of its
	// component instance; unmounting it for /model or /resume prints the banner
	// and settled history again when the picker closes.
	const [transcriptOwned, setTranscriptOwned] = useState(false)
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
	const [pickerInitialView, setPickerInitialView] = useState<
		'providers' | 'subscriptions' | 'models'
	>('providers')
	/** A narrowed first-run roster; null keeps the complete discovered list. */
	const [pickerDetected, setPickerDetected] = useState<readonly DetectedProvider[] | null>(null)
	/** Whether Enter accepts the provider directly or continues to model choice. */
	const [pickerSelectionKind, setPickerSelectionKind] = useState<
		'provider-and-model' | 'signed-in-subscription'
	>('provider-and-model')
	/** Active preferences, or the saved chain awaiting its missing credential. */
	const savedPrefsRef = useRef<Preferences | null>(null)
	// `--provider`/`--model`/`--effort` apply to the first session this launch opens and then
	// step aside, so a later `/model` or a re-login behaves as it always did.
	const launchModelPendingRef = useRef(choosesModel(initialCtx.launchSettings))
	// Whether Auto (per-task model routing) is what runs. It starts on when
	// `model: auto` is the default and no `--model` pinned one; picking a model
	// by hand turns it off, and choosing Auto in the picker or `/model auto`
	// turns it back on. Auto needs the configured `routing` block to be
	// available at all.
	const autoActiveRef = useRef(initialCtx.routing !== undefined && initialCtx.autoDefault === true)
	const [autoActive, setAutoActive] = useState(autoActiveRef.current)
	const launchEffortPendingRef = useRef(initialCtx.launchSettings?.effort)
	/**
	 * Why the picker is open, drawn ON the picker.
	 *
	 * Pushed into the transcript as well — it belongs in the scrollback the
	 * operator keeps — but the transcript is not rendered during this phase, so
	 * the transcript copy alone was an explanation nobody could read at the
	 * moment it mattered. Both refusals that route here use it.
	 */
	const [pickerNotice, setPickerNotice] = useState<string | null>(null)
	const [permission, setPermission] = useState<PendingPermission | null>(null)
	/**
	 * The question currently on screen and the promise the tool is waiting
	 * on. Resolved exactly once: by a chosen row, by free text, by Esc (skip)
	 * or by Ctrl+C (abort). A second resolution is a no-op, not a second
	 * answer.
	 */
	const questionRef = useRef<{
		readonly question: UserQuestion
		resolve: ((answer: QuestionAnswer) => void) | null
	} | null>(null)
	const resolveQuestion = useCallback((answer: QuestionAnswer): void => {
		const pending = questionRef.current
		if (!pending?.resolve) return
		const resolve = pending.resolve
		pending.resolve = null
		questionRef.current = null
		resolve(answer)
	}, [])
	const [permissionReviewOffset, setPermissionReviewOffsetState] = useState(0)
	const permissionReviewOffsetRef = useRef(0)
	const [permissionDetailsOpen, setPermissionDetailsOpenState] = useState(false)
	const permissionDetailsOpenRef = useRef(false)
	const setPermissionDetailsOpen = useCallback((next: boolean) => {
		permissionDetailsOpenRef.current = next
		setPermissionDetailsOpenState(next)
	}, [])
	const setPermissionReviewOffset = useCallback((next: number) => {
		permissionReviewOffsetRef.current = next
		setPermissionReviewOffsetState(next)
	}, [])
	// Which of the three answers the cursor is on. Opens on "Yes", as the
	// prompt an operator knows from elsewhere does; Enter confirms it only
	// after the same settle window `y` and `a` wait out.
	const [permissionChoice, setPermissionChoiceState] = useState<PermissionChoice>(0)
	const permissionChoiceRef = useRef<PermissionChoice>(0)
	const setPermissionChoice = useCallback((next: PermissionChoice) => {
		permissionChoiceRef.current = next
		setPermissionChoiceState(next)
	}, [])
	// The launch bypass is an INITIAL selection, not permanent authority. A
	// typed /permissions command can narrow it back to prompt/strict without
	// rebuilding the provider, tools, plugins, or sandbox.
	// `--permission-mode` names the starting mode outright and wins over the bypass alias.
	const launchPermissionMode = ctx.palId ? undefined : ctx.launchSettings?.permissionMode
	const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
		launchPermissionMode ??
			(ctx.skipPermissions === true ? 'bypass' : ctx.palId ? 'auto' : 'prompt'),
	)
	const permissionModeRef = useRef<PermissionMode>(permissionMode)
	// Whether Shift+Tab and /permissions may land on bypass. Fixed at launch
	// (a flag that names it, or the operator's own default) and shut by
	// `permissions.disableBypassMode`; nothing typed inside the session opens it.
	const autoModeNoticeShownRef = useRef(false)
	const bypassAvailableRef = useRef(
		ctx.bypassAvailable ??
			(ctx.skipPermissions === true ||
				ctx.allowDangerouslySkipPermissions === true ||
				permissionMode === 'bypass'),
	)
	const permissionModeSourceRef = useRef<
		'default' | 'launch-bypass' | 'launch-flag' | 'config-default' | 'session'
	>(
		ctx.permissionSource === 'config-default'
			? 'config-default'
			: launchPermissionMode
				? 'launch-flag'
				: ctx.skipPermissions === true
					? 'launch-bypass'
					: 'default',
	)
	const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort | undefined>()
	const reasoningEffortRef = useRef<ReasoningEffort | undefined>(undefined)
	const turnLimitsOverrideRef = useRef<Partial<TurnGuards>>({})
	const setReasoningEffort = useCallback((next: ReasoningEffort | undefined) => {
		reasoningEffortRef.current = next
		setReasoningEffortState(next)
	}, [])
	// A session setting layered above effort, not a level a provider publishes
	// — see docs/cli/slash-commands.md's /effort section. In-memory and
	// per-session like reasoningEffort above; no preferences file involved.
	// Starts on when the `hypermode` config key says so; `/hypermode off` ends it
	// for this conversation only.
	const [hypermode, setHypermodeState] = useState(initialCtx.hypermode === true)
	const hypermodeRef = useRef(initialCtx.hypermode === true)
	const [hypermodeActivation, setHypermodeActivation] = useState(0)
	const setHypermode = useCallback((next: boolean) => {
		hypermodeRef.current = next
		setHypermodeState(next)
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
	/** A frequently edited file of this repository, for the first prompt's example. */
	const [exampleFile, setExampleFile] = useState<string | undefined>(undefined)
	/** Which example to show; chosen once per launch so it does not change while the operator reads it. */
	const exampleSeedRef = useRef(Math.random())
	// What compaction has done this session, summed over passes; `/context`
	// prints it. Reset with the session, never by a pass that declined.
	const [compactionTally, setCompactionTally] = useState({
		passes: 0,
		clearedResults: 0,
		stubbedNarrations: 0,
		summaries: 0,
		reclaimedTokens: 0,
	})
	// Keep exits until the kernel acknowledges delivery or a later completed
	// turn carries them. An exit after the last tool result still needs that
	// next turn, while every exit gets one immediate transcript row.
	const idleJobNoticesRef = useRef<{
		readonly ownerSession: AgentSession | null
		readonly pending: Map<string, string>
		readonly delivered: Set<string>
		readonly shown: Set<string>
	}>({
		ownerSession: null,
		pending: new Map(),
		delivered: new Set(),
		shown: new Set(),
	})
	const [jobSnapshot, setJobSnapshot] = useState<{
		readonly ownerSession: AgentSession | null
		readonly jobs: readonly BackgroundJob[]
	}>({ ownerSession: null, jobs: [] })
	const backgroundJobs = jobSnapshot.ownerSession === session ? jobSnapshot.jobs : []
	const snapshotIdleJobNotices = (): {
		readonly ids: readonly string[]
		readonly text?: string
	} => {
		if (idleJobNoticesRef.current.ownerSession !== session) return { ids: [] }
		const pending = idleJobNoticesRef.current.pending
		if (pending.size === 0) return { ids: [] }
		const lines = [...pending.values()]
		return {
			ids: [...pending.keys()],
			text: `Background jobs that ended since your last turn:\n${lines.map((l) => `- ${l}`).join('\n')}`,
		}
	}
	/** What monitors said since the last turn: the same envelopes the kernel gives in-turn. */
	const snapshotMonitorNotices = (): {
		readonly ids: readonly string[]
		readonly text?: string
	} => session?.monitors?.peek() ?? { ids: [] }
	// Commands the operator ran with `!` since the last turn. The model did
	// not see them happen; it reads them here on its next turn.
	const operatorShellRef = useRef<string[]>([])
	const drainOperatorShell = (): string | undefined => {
		if (operatorShellRef.current.length === 0) return undefined
		const blocks = operatorShellRef.current
		operatorShellRef.current = []
		return `What the operator did outside you since your last turn — commands they ran in their own shell, files they put back — with the output:\n\n${blocks.join('\n\n')}`
	}
	useEffect(() => {
		const notices = {
			ownerSession: session,
			pending: new Map<string, string>(),
			delivered: new Set<string>(),
			shown: new Set<string>(),
		}
		idleJobNoticesRef.current = notices
		setJobSnapshot({ ownerSession: session, jobs: session?.jobs?.() ?? [] })
		if (!session?.onJobExit) return
		// Something a monitor said, or its end, arrived: an idle session looks
		// again at whether to wake. The ledger itself lives on the session.
		const offMonitors = session.monitors?.onChange(() => {
			if (previousSessionRef.current !== session) return
			setNoticeVersion((version) => version + 1)
		})
		const offExits = session.onJobExit((job) => {
			// The visible running-shell count belongs to the session even when
			// the kernel owns this exit's model/transcript notice.
			if (previousSessionRef.current !== session || idleJobNoticesRef.current !== notices) return
			setJobSnapshot({ ownerSession: session, jobs: session.jobs?.() ?? [] })
			if (job.kind === 'monitor') {
				// A monitor's end is told in the monitor's own words, and its notice
				// for the model sits in the session's monitor ledger, not in the
				// plain job notices.
				if (!notices.shown.has(job.id)) {
					notices.shown.add(job.id)
					const row = monitorEndRow(job, session.monitors?.stats(job.id) ?? { stdoutChars: 0 })
					pushMessage('system', row.text, false, '●', undefined, row.color, row.meta)
				}
				return
			}
			const text = describeJobExit({
				jobId: job.id,
				command: job.command,
				status: job.status === 'killed' ? 'killed' : 'exited',
				...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
				...(job.signal ? { signal: job.signal } : {}),
			})
			// SDK delivery can run before this listener on a host with different
			// subscription order. The tombstone keeps that acknowledged exit out of
			// the next turn even when its UI event arrives later.
			if (!notices.delivered.has(job.id)) {
				notices.pending.set(job.id, text)
				if (job.status !== 'killed') wakeJobIdsRef.current.add(job.id)
				setNoticeVersion((version) => version + 1)
			}
			if (!notices.shown.has(job.id)) {
				notices.shown.add(job.id)
				const row = jobExitRow({
					command: job.command,
					status: job.status === 'killed' ? 'killed' : 'exited',
					...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
					...(job.signal ? { signal: job.signal } : {}),
					...(job.exitedAt !== undefined ? { runtimeMs: job.exitedAt - job.startedAt } : {}),
				})
				pushMessage('system', row.text, false, '●', undefined, row.color, row.meta)
			}
		})
		return () => {
			offMonitors?.()
			offExits()
		}
	}, [session])
	// What ended in a workflow, for the model: one message per run, delivered
	// inside a running turn when there is one and with the next turn otherwise,
	// the way a background job's exit is.
	const workflowNoticesRef = useRef(new Map<string, string>())
	/** What running agents sent to the conversation, for the model: told once, like a workflow's end. */
	const childMessagesRef = useRef(new Map<number, string>())
	const childMessageIdRef = useRef(0)
	/** Moves when something ended that the model has not been told, so an idle session can wake. */
	const [noticeVersion, setNoticeVersion] = useState(0)
	/** Background commands that ended on their own (a stop the operator asked for does not wake the model). */
	const wakeJobIdsRef = useRef(new Set<string>())
	useEffect(() => {
		workflowNoticesRef.current = new Map()
		const source = session?.workflows
		if (!source) return
		return source.onEnd(({ view }) => {
			if (previousSessionRef.current !== session) return
			// One line in the conversation, written when the run ends, not when a turn does.
			const notice = workflowNotice(runRailWorkflow(view, []))
			pushMessage(
				'tool',
				notice.content,
				false,
				notice.glyph,
				undefined,
				notice.tone === 'error'
					? tokenColor('status.error')
					: notice.tone === 'warn'
						? tokenColor('status.warn')
						: tokenColor('status.ok'),
			)
			workflowNoticesRef.current.set(view.runId, completionNotice(view))
			activeTurnInboxRef.current?.notify()
			setNoticeVersion((version) => version + 1)
		})
	}, [session])
	const [usage, setUsage] = useState<{
		budget?: Extract<AgentEvent, { kind: 'usage' }>['budget']
		totalTokens: number
		cost: CostInfo
		/**
		 * See the `usage` event: absent when the turn resolved no window. Read
		 * by `/cost`, and by the footer only once the window is within 20,000
		 * tokens of the summary point (`context-meter.ts`) — the always-on gauge
		 * was removed on purpose (iteration 168).
		 */
		context?: {
			tokens: number
			windowTokens: number
			measured: boolean
			windowAssumed: boolean
		}
	} | null>(null)
	/**
	 * The model's current reasoning, last line only, for the live region.
	 * Never appended to a message: the kernel keeps reasoning out of its
	 * own transcript, and this exists so a long think reads as work rather
	 * than as silence. Cleared by the first text or tool call that follows.
	 */
	const [thinking, setThinking] = useState<string | null>(null)
	// Why the reply is quiet while the provider is being waited on or retried.
	const [providerWaitNotice, setProviderWaitNotice] = useState<ProviderWaitNotice | null>(null)
	const providerWaitNoticeRef = useRef<ProviderWaitNotice | null>(null)
	/** Output tokens of the running turn, for the Working row. See `StreamState`. */
	const [turnTokens, setTurnTokens] = useState(0)
	const turnTokensShownAt = useRef(0)
	const turnTokensTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(
		() => () => {
			if (turnTokensTimer.current) clearTimeout(turnTokensTimer.current)
		},
		[],
	)
	// Tools currently executing — rendered live (spinner + elapsed) below the
	// transcript, then committed as static lines on completion.
	const [activeTools, setActiveTools] = useState<readonly RunningTool[]>([])
	/**
	 * The model's plan for the current request, in creation order, updated in
	 * place on every status change. Cleared when the next request begins —
	 * a plan is scoped to the request it was made for, and one that outlived
	 * it would read as work still pending on a turn that already ended.
	 */
	const [tasks, setTasks] = useState<readonly TaskListItem[]>([])
	/**
	 * The same list, current NOW. React runs state updaters lazily, and each
	 * task event needs the task's previous state to say what changed and the
	 * whole list to draw the block it leaves in the transcript.
	 */
	const tasksRef = useRef<readonly TaskListItem[]>([])
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
	// Complete prompts waiting for the one queue pump that may start a turn.
	const [queued, setQueued] = useState<readonly QueuedPrompt[]>([])
	// Esc can make the screen idle before an aborted iterator settles. Recheck
	// the queue when that iterator releases its turn token, even if `idle` did
	// not change and no new prompt was appended in its finally block.
	const [queueSettleVersion, setQueueSettleVersion] = useState(0)
	/** Return-submitted prompts accepted by the active turn but not yet drained by the SDK. */
	const [pendingSteers, setPendingSteers] = useState<readonly LiveInput[]>([])
	// Kept synchronous with the rendered queue so a turn's `finally` can decide
	// whether it is truly the last turn. React state captured when the turn
	// started would still say "empty" after the operator queued a follow-up.
	const queuedRef = useRef<readonly QueuedPrompt[]>([])
	/**
	 * A failed operator or peer turn holds automatic work until the operator
	 * explicitly continues. A ref is the admission gate; state is its rendered
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
	// A summary is being written inside a running reply (the clearing pass was
	// not enough), so the live area says so until the pass ends.
	const [summarising, setSummarising] = useState(false)
	// The session whose effort listing has answered, so "still loading" is never
	// said about a model that already reported it has no levels.
	const reasoningListedRef = useRef<AgentSession | null>(null)
	const [resumeList, setResumeList] = useState<readonly RecentConversation[]>([])
	const {
		selection: selectedResume,
		selectionRef: selectedResumeRef,
		setSelection: setSelectedResume,
	} = useSelectionIndex(0)
	const [editList, setEditList] = useState<readonly EditablePrompt[]>([])
	/** The rewind dialog: the prompts it offers, where it stands, and when it opened. */
	const [rewind, setRewind] = useState<{
		readonly rows: readonly RewindRow[]
		readonly state: RewindState
		readonly openedAt: number
	} | null>(null)
	const rewindRef = useRef<typeof rewind>(null)
	const rewindGenRef = useRef(0)
	const setRewindView = useCallback((next: typeof rewind) => {
		rewindRef.current = next
		setRewind(next)
	}, [])
	const editCommittedRef = useRef(false)
	/** `/copy` owns this exact response snapshot until selection or cancellation. */
	const [copyPicker, setCopyPickerState] = useState<CopyPickerState | null>(null)
	const copyPickerRef = useRef<CopyPickerState | null>(null)
	const copyPickerCommittedRef = useRef<CopyPickerState | null>(null)
	const {
		selection: selectedCopy,
		selectionRef: selectedCopyRef,
		setSelection: setSelectedCopy,
	} = useSelectionIndex(0)
	const setCopyPicker = useCallback((next: CopyPickerState | null) => {
		copyPickerRef.current = next
		if (next === null) copyPickerCommittedRef.current = null
		setCopyPickerState(next)
	}, [])
	useEffect(() => {
		copyPickerCommittedRef.current = copyPicker
	}, [copyPicker])
	/** Finite slash-command choice owned synchronously until apply or cancel. */
	const [providerSetup, setProviderSetup] = useState(false)
	const [choicePicker, setChoicePickerState] = useState<ChoicePickerState | null>(null)
	const choicePickerRef = useRef<ChoicePickerState | null>(null)
	const [choiceQuery, setChoiceQuery] = useState('')
	const choiceQueryRef = useRef('')
	/**
	 * Exact chooser React has committed. The synchronous owner ref is needed to
	 * block queue/goal work immediately, but it must not accept the Return key
	 * that created it before a menu has existed in the rendered tree.
	 */
	const choicePickerCommittedRef = useRef<ChoicePickerState | null>(null)
	const commandPickerSubmitRef = useRef<(command: string) => void>(() => {})
	/** A command line the person confirmed to run against the conversation while an agent was viewed. */
	const mainCommandConfirmedRef = useRef<string | null>(null)
	const {
		selection: selectedChoice,
		selectionRef: selectedChoiceRef,
		setSelection: setSelectedChoice,
	} = useSelectionIndex(0)
	const setChoicePicker = useCallback((next: ChoicePickerState | null) => {
		choicePickerRef.current = next
		choiceQueryRef.current = ''
		setChoiceQuery('')
		if (next === null) choicePickerCommittedRef.current = null
		setChoicePickerState(next)
	}, [])
	// A painted menu must already accept its first key. A passive effect can
	// run after Ink flushes that frame, leaving the ownership fence closed.
	useLayoutEffect(() => {
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
	const [composerHasDraft, setComposerHasDraft] = useState(false)
	// A turn a tool paused for a person (`ToolResult.handoff`), while its
	// notice is the newest thing on screen: Enter continues it, Esc stops it.
	// The ref is what the key handler reads; the state is what the footer shows.
	/**
	 * The stream of the turn running now, so a tool's own screen can close the
	 * reply it streamed before the tool ran. The kernel hands the tool's start
	 * to this loop only when its batch settles, so a reply streamed with a
	 * tool call stays pending while that tool asks the operator something; a
	 * row written then (the schedule tool's confirmation) cannot reach
	 * scrollback past the pending reply, and the top of a tall one was cut
	 * off while the operator was asked about it.
	 */
	const liveStreamRef = useRef<StreamState | null>(null)
	const [handoffPark, setHandoffParkState] = useState<{
		readonly turnId: string
		readonly reason?: string
	} | null>(null)
	const handoffParkRef = useRef<{
		readonly turnId: string
		readonly reason?: string
	} | null>(null)
	const setHandoffPark = useCallback(
		(value: { readonly turnId: string; readonly reason?: string } | null) => {
			handoffParkRef.current = value
			setHandoffParkState(value)
		},
		[],
	)
	const composerDraftTokenRef = useRef(0)
	/** Bounded child session projection published by the current AgentSession. */
	const [subagents, setSubagentsState] = useState<readonly SubagentActivity[]>([])
	const subagentsRef = useRef<readonly SubagentActivity[]>([])
	/** The `workflow` tool's runs; their agents reach `subagents` as projected rows. */
	const [workflowRuns, setWorkflowRuns] = useState<readonly WorkflowRunView[]>([])
	const workflowRunsRef = useRef<readonly WorkflowRunView[]>([])
	/**
	 * The parent's own commentary on the work it is coordinating, from the same
	 * monitor and the same subscription as the rows below it. Read through the
	 * optional reader, so a source that publishes no narration is simply a
	 * session with none.
	 */
	const [narration, setNarration] = useState<readonly SubagentNarrationLine[]>([])
	const [agentSurface, setAgentSurfaceState] = useState<AgentSurface | null>(null)
	/**
	 * The agents rail's keyboard focus: `main`, a row's view id, or null when the
	 * composer owns the keys. The ref is what the key handler reads, because a
	 * burst of keys arrives before React commits the state.
	 */
	const [railFocus, setRailFocusState] = useState<string | null>(null)
	const railFocusRef = useRef<string | null>(null)
	/** Running background shells, read by key handlers that run before the render that counts them. */
	const shellCountRef = useRef(0)
	const setRailFocus = useCallback((next: string | null) => {
		railFocusRef.current = next
		setRailFocusState(next)
	}, [])
	/** Agents the operator cleared with `x` after they finished. */
	const [dismissedAgents, setDismissedAgents] = useState<ReadonlySet<string>>(() => new Set())
	/** Clock for the rail's 30 s finished-agent lifetime; moved only when a row is due to leave. */
	const [railNow, setRailNow] = useState(() => Date.now())
	/** The agent on screen, kept on the rail however it ended. */
	const pinnedViewId = agentSurface?.kind === 'transcript' ? agentSurface.selectedId : null
	const railRowsRef = useRef<readonly SubagentActivity[]>([])
	const railWorkflowsRef = useRef<readonly RailWorkflow[]>([])
	const railJustFocusedRef = useRef(false)
	/** ctrl+x was the last key on the rail: ctrl+k next stops every running agent. */
	const railChordRef = useRef(false)
	/** The first press of the stop-all chord is waiting for its second (3 s). */
	const stopAllArmedRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	/** The agent whose transcript the main screen shows, or null when it shows the conversation. */
	const viewingAgentRef = useRef<string | null>(null)
	const viewRailRowsRef = useRef(0)
	/** One plain sentence about the last message to the viewed agent that could not go. */
	const [viewNotice, setViewNotice] = useState<string | undefined>(undefined)
	// A finished agent leaves the rail 30 s after it ended: sleep until the next
	// one is due instead of ticking, so a quiet session renders nothing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `railNow` is not read here; moving it is what re-arms the timer for the next agent due to leave.
	useEffect(() => {
		const wait = railNextEviction(subagents, Date.now(), workflowRuns)
		if (wait === undefined) return
		const timer = setTimeout(() => setRailNow(Date.now()), wait + 20)
		timer.unref?.()
		return () => clearTimeout(timer)
	}, [subagents, workflowRuns, railNow])
	// The rail cannot keep the keyboard once it has nothing to show.
	const railHasRows =
		railAgents(subagents, railNow, dismissedAgents, pinnedViewId).length > 0 ||
		railWorkflows(subagents, railNow, dismissedAgents, workflowRuns).length > 0
	// The footer's shell pill is the rail's first stop, so shells keep it focused too.
	const footerHasShells = backgroundJobs.some((job) => job.status === 'running')
	useEffect(() => {
		if (!railHasRows && !footerHasShells && railFocus !== null) setRailFocus(null)
		else if (!footerHasShells && railFocus === SHELLS_FOCUS) setRailFocus(null)
	}, [railHasRows, footerHasShells, railFocus, setRailFocus])
	const [jobSurfaceState, setJobSurfaceState] = useState<JobSurface | null>(null)
	const jobSurface = jobSurfaceState?.ownerSession === session ? jobSurfaceState : null
	const jobSurfaceRef = useRef<JobSurface | null>(null)
	const jobSurfaceCommittedRef = useRef<JobSurface | null>(null)
	const setJobSurface = useCallback((next: JobSurface | null) => {
		const wasVisible = jobSurfaceCommittedRef.current !== null
		jobSurfaceRef.current = next
		if (next === null) jobSurfaceCommittedRef.current = null
		else if (wasVisible) jobSurfaceCommittedRef.current = next
		setJobSurfaceState(next)
	}, [])
	useLayoutEffect(() => {
		jobSurfaceCommittedRef.current = jobSurface
	}, [jobSurface])
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => setJobSurface(null), [session, setJobSurface])
	const [jobClock, setJobClock] = useState(Date.now())
	const hasRunningBackgroundJob = backgroundJobs.some((job) => job.status === 'running')
	const jobSurfaceOpen = jobSurface !== null
	useEffect(() => {
		if (!jobSurfaceOpen || !hasRunningBackgroundJob) return
		const timer = setInterval(() => {
			setJobClock(Date.now())
			setJobSnapshot({ ownerSession: session, jobs: session?.jobs?.() ?? [] })
		}, 1000)
		return () => clearInterval(timer)
	}, [jobSurfaceOpen, hasRunningBackgroundJob, session])
	const agentSurfaceRef = useRef<AgentSurface | null>(null)
	const agentSurfaceCommittedRef = useRef<AgentSurface | null>(null)
	const childMessageLifetimeRef = useRef(new AbortController())
	const directChildNoticesRef = useRef(new Map<number, DirectChildNotice>())
	const directChildNoticeIdRef = useRef(0)
	const setAgentSurface = useCallback((next: AgentSurface | null) => {
		const wasVisible = agentSurfaceCommittedRef.current !== null
		agentSurfaceRef.current = next
		if (next === null) agentSurfaceCommittedRef.current = null
		// Only opening the surface needs a paint fence. Once the operator has
		// seen it, navigation may update the state object several times in one
		// terminal input burst; those updates remain actionable immediately.
		else if (wasVisible) agentSurfaceCommittedRef.current = next
		setAgentSurfaceState(next)
	}, [])
	useEffect(() => {
		agentSurfaceCommittedRef.current = agentSurface
	}, [agentSurface])
	/**
	 * Children of this conversation's earlier turns, rebuilt from their own
	 * session logs, kept apart from the live monitor's own snapshot.
	 *
	 * A ref and not state because it is an input to `replaceSubagents`, which
	 * runs from the monitor's subscription: holding it as state would make
	 * every saved row arrive one render after the live rows it belongs beside.
	 */
	const savedSubagentsRef = useRef<readonly SubagentActivity[]>([])
	/** Revokes an in-flight evidence read whose session or conversation is gone. */
	const savedSubagentsTokenRef = useRef(0)
	const withSavedSubagents = useCallback(
		(live: readonly SubagentActivity[]): readonly SubagentActivity[] => {
			const saved = savedSubagentsRef.current
			if (saved.length === 0) return live
			// A child the live monitor still holds wins over its own saved copy:
			// both describe one child session, and only one of the two is attached
			// to anything. Saved rows land after the live ones, so a cohort that is
			// still running keeps the top of the list.
			const liveSessionIds = new Set(
				live.map((agent) => agent.sessionId).filter((id): id is string => id !== undefined),
			)
			return [
				...live,
				...saved.filter((agent) => !agent.sessionId || !liveSessionIds.has(agent.sessionId)),
			]
		},
		[],
	)
	const replaceSubagents = useCallback(
		(incoming: readonly SubagentActivity[]) => {
			const next = withWorkflowRuns(withSavedSubagents(incoming), workflowRunsRef.current)
			const previous = subagentsRef.current
			subagentsRef.current = next
			setSubagentsState(next)
			const surface = agentSurfaceRef.current
			if (!surface) return
			if (next.length === 0 && workflowRunsRef.current.length === 0) {
				setAgentSurface(null)
				return
			}
			// A phase of a workflow run that nothing has started in has no agent
			// to select; the surface stays on the phase until one does.
			if (
				surface.selectedId === '' &&
				agentWorkflows(next, workflowRunsRef.current).some((workflow) =>
					workflow.phases.some((phase) => phase.id === surface.selectedPhaseId),
				)
			)
				return
			const retained = next.find((agent) => agent.viewId === surface.selectedId)
			if (retained) {
				if (retained.phaseId !== surface.selectedPhaseId) {
					setAgentSurface({ ...surface, selectedPhaseId: retained.phaseId })
				}
				return
			}
			const phases = agentWorkflows(next, workflowRunsRef.current).flatMap(
				(workflow) => workflow.phases,
			)
			const previousGroupId = previous.find(
				(agent) => agent.viewId === surface.selectedId,
			)?.workflowGroupId
			const sameWorkflow = agentWorkflows(next, workflowRunsRef.current).find(
				(workflow) => workflow.id === previousGroupId,
			)
			const fallbackPhase =
				phases.find((phase) => phase.id === surface.selectedPhaseId) ??
				sameWorkflow?.phases[0] ??
				phases[0]
			const fallbackAgent = fallbackPhase?.agents[0]
			if (!fallbackPhase || !fallbackAgent) {
				setAgentSurface(null)
				return
			}
			setAgentSurface({
				kind: 'cockpit',
				selectedPhaseId: fallbackPhase.id,
				selectedId: fallbackAgent.viewId,
				focus: surface.kind === 'cockpit' ? surface.focus : surface.returnFocus,
			})
		},
		[setAgentSurface, withSavedSubagents],
	)
	const idRef = useRef<number>(0)
	const nextId = useCallback(() => {
		idRef.current += 1
		return `m${idRef.current}`
	}, [])
	const takeThinking = useCallback(() => {
		const text = thinkingForNextRowRef.current
		if (text.trim() === '') return undefined
		thinkingForNextRowRef.current = ''
		return text
	}, [])
	const readSearchGroup = useReadSearchGroup(setMessages, nextId, takeThinking)
	/**
	 * Re-reads what this conversation's finished children left on disk.
	 *
	 * Called when a session is installed, whenever the conversation the scope
	 * names changes — a resume is the whole point of this: the children worth
	 * opening belong to the runs of the conversation just switched TO — and
	 * whenever the cockpit is opened, which is what recovers a child the live
	 * monitor's eighty-agent bound has since evicted. All three are reads of
	 * directories that are already there; nothing is created, and a failure
	 * leaves the live rows untouched.
	 */
	const hydrateSavedChildren = useCallback(async (): Promise<void> => {
		const read = session?.savedChildren
		if (!read) return
		const token = ++savedSubagentsTokenRef.current
		let saved: readonly SubagentActivity[]
		try {
			saved = await read()
		} catch {
			// Saved evidence is an extra view over a directory that may not exist
			// yet, or may not be readable. Not finding it is not a reason to
			// disturb a session whose live children are fine.
			return
		}
		if (token !== savedSubagentsTokenRef.current) return
		savedSubagentsRef.current = saved
		// The rows of the agents a resumed conversation launched, where it launched them.
		setMessages((rows) => withSavedAgentRows(rows, saved, nextId))
		replaceSubagents(session?.subagents?.getSnapshot() ?? [])
	}, [nextId, replaceSubagents, session])
	/** Opens the cockpit on the rows already on screen; false when there are none. */
	const openCockpitFromCurrentRows = useCallback((): boolean => {
		const agents = subagentsRef.current
		const workflows = agentWorkflows(agents, workflowRunsRef.current)
		const currentWorkflow =
			[...workflows]
				.reverse()
				.find((workflow) =>
					workflow.agents.some(
						(agent) =>
							agent.status === 'starting' ||
							agent.status === 'queued' ||
							agent.status === 'working',
					),
				) ?? workflows.at(-1)
		// Opened on the work that is moving: the first phase with a live agent,
		// and its first live agent, rather than on a phase that finished
		// minutes ago. With nothing live, the first phase, as before.
		const live = (agent: SubagentActivity): boolean =>
			agent.status === 'starting' || agent.status === 'queued' || agent.status === 'working'
		const firstPhase =
			currentWorkflow?.phases.find((phase) => phase.agents.some(live)) ?? currentWorkflow?.phases[0]
		const firstAgent = firstPhase?.agents.find(live) ?? firstPhase?.agents[0]
		if (!firstPhase || (!firstAgent && currentWorkflow?.runId === undefined)) return false
		setAgentSurface({
			kind: 'cockpit',
			selectedPhaseId: firstPhase.id,
			selectedId: firstAgent?.viewId ?? '',
			focus:
				workflows.length > 1
					? 'workflows'
					: currentWorkflow
						? cockpitEntryFocus(currentWorkflow)
						: 'agents',
		})
		return true
	}, [setAgentSurface])
	/**
	 * Enter on a workflow row: the cockpit, opened on that workflow's phases
	 * (or its agents when it has one phase), on the phase still moving. Esc
	 * walks back to the row.
	 */
	const openWorkflowFromRail = useCallback(
		(groupId: string, railReturn?: string): boolean => {
			const workflow = agentWorkflows(subagentsRef.current, workflowRunsRef.current).find(
				(item) => item.id === groupId,
			)
			const live = (agent: SubagentActivity): boolean =>
				agent.status === 'starting' || agent.status === 'queued' || agent.status === 'working'
			const phase = workflow?.phases.find((item) => item.agents.some(live)) ?? workflow?.phases[0]
			const agent = phase?.agents.find(live) ?? phase?.agents[0]
			if (!workflow || !phase || (!agent && workflow.runId === undefined)) return false
			setAgentSurface({
				kind: 'cockpit',
				selectedPhaseId: phase.id,
				selectedId: agent?.viewId ?? '',
				focus: cockpitEntryFocus(workflow),
				...(railReturn !== undefined ? { railReturn } : {}),
			})
			return true
		},
		[setAgentSurface],
	)
	/** The most recent cockpit request, so an older one cannot report on its behalf. */
	const cockpitOpenTokenRef = useRef(0)
	/**
	 * Ctrl+T and `/agents`: open the cockpit, and when nothing is on screen
	 * yet, WAIT for the saved evidence before answering.
	 *
	 * The waiting is the point. A conversation's children may exist only on
	 * disk — evicted by the eighty-agent bound, or written by a process that
	 * has since exited — and that read is asynchronous. Answering from the
	 * rows already up would make the first press after a resume report an
	 * absence that the read, still in flight, was about to disprove. Rows that
	 * ARE up open immediately and refresh the saved ones behind the screen, so
	 * the common case pays nothing for this.
	 */
	const openAgentCockpit = useCallback(async (): Promise<boolean> => {
		if (openCockpitFromCurrentRows()) {
			void hydrateSavedChildren()
			return true
		}
		const token = ++cockpitOpenTokenRef.current
		await hydrateSavedChildren()
		// A later request owns the screen now. Reporting `false` here would put
		// an empty-state line under a cockpit that request is about to open.
		if (token !== cockpitOpenTokenRef.current) return true
		return openCockpitFromCurrentRows()
	}, [hydrateSavedChildren, openCockpitFromCurrentRows])
	/**
	 * Empty-composer ↓: move into the agents rail when it has rows, otherwise
	 * open the cockpit for the saved children it can still show.
	 */
	const focusAgentRail = useCallback(() => {
		const first =
			// Viewing an agent, ↓ lands on its own row: one more ↑ reaches `main`.
			viewingAgentRef.current ??
			(shellCountRef.current > 0 ? SHELLS_FOCUS : undefined) ??
			railRowsRef.current[0]?.viewId ??
			railWorkflowsRef.current[0]?.focusId
		if (first && (agentSurfaceRef.current === null || viewingAgentRef.current !== null)) {
			// The ↓ that gets here is also dispatched to App's own key handler in
			// the same tick, which must not read it as the first step inside the rail.
			railJustFocusedRef.current = true
			setTimeout(() => {
				railJustFocusedRef.current = false
			}, 0)
			setRailFocus(first)
			return
		}
		void openAgentCockpit()
	}, [openAgentCockpit, setRailFocus])
	/** The shells screen `/jobs` opens; the footer's pill reaches the same one. */
	const openShellJobs = useCallback(() => {
		if (!session) return
		setJobSnapshot({ ownerSession: session, jobs: session.jobs?.() ?? [] })
		setJobClock(Date.now())
		const current = session.jobs?.() ?? []
		setJobSurface({
			ownerSession: session,
			selectedJobId: current.find((job) => job.status === 'running')?.id ?? current[0]?.id ?? null,
			detailJobId: null,
			tailOffset: 0,
		})
	}, [session, setJobSurface])
	/** One git-backed review choice may be resolving while its visible picker remains authoritative. */
	const reviewChoiceInFlightRef = useRef<object | null>(null)
	const exitArmedRef = useRef<'Ctrl-C' | 'Ctrl-D' | null>(null)
	const abortRef = useRef<AbortController | null>(null)
	/**
	 * A prompt that holds the turn slot while it waits at the turn boundary,
	 * before it has an abort controller. An interrupt or a conversation switch
	 * takes the slot back by clearing this; the prompt then drops itself.
	 */
	const admissionRef = useRef<object | null>(null)
	/** Identity of the turn allowed to notify when it settles. */
	const activeTurnTokenRef = useRef<object | null>(null)
	/** A tool can reserve a switch; only the owning turn's finalizer may publish it. */
	const pendingModelSwitchRef = useRef<PendingModelSwitch | null>(null)
	const [modelSwitchVersion, setModelSwitchVersion] = useState(0)
	const cancelPendingModelSwitch = useCallback((): boolean => {
		const pending = pendingModelSwitchRef.current
		if (!pending) return false
		pendingModelSwitchRef.current = null
		pending.controller.abort(new Error('The pending model switch was cancelled.'))
		setModelSwitchVersion((version) => version + 1)
		return true
	}, [])
	/** Exact live-input owner; absent before provider admission and after settlement. */
	const activeTurnInboxRef = useRef<ActiveTurnInbox | null>(null)
	/** A broken terminal notification is reported once, not after every turn. */
	const notificationFailureShownRef = useRef(false)
	// When a key was last pressed: the idle notice is for a person who walked away.
	const lastKeyAtRef = useRef(Date.now())
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
	const runProbeRef = useRef<
		| ((options?: {
				readonly signal?: AbortSignal
				readonly announce?: boolean
		  }) => Promise<void>)
		| null
	>(null)
	useEffect(() => cancelPendingLogin, [cancelPendingLogin])
	/**
	 * The session currently holding resources, so a re-hydration can release the
	 * one it replaces. A `/model` switch builds a new session, and a tool
	 * server's child process outlives the object that opened it.
	 */
	const previousSessionRef = useRef<AgentSession | null>(null)
	/** Bumped when a session's effort levels arrive after it opened, to redraw what reads them. */
	const [, setReasoningVersion] = useState(0)
	/** The profile `/browser profile` chose, kept across session rebuilds. */
	const browserProfileRef = useRef<string | undefined>(undefined)
	/** The current session's browser, for notices written from event handlers. */
	const browserControlRef = useRef<BrowserControl | undefined>(undefined)
	/** The current session, for the review screen to name a computer-use control by its ref. */
	const reviewSessionRef = useRef<AgentSession | null>(null)
	useEffect(() => {
		browserControlRef.current = session?.browser
		reviewSessionRef.current = session
	}, [session])
	useEffect(() => {
		const source = session?.subagents
		childMessageLifetimeRef.current.abort(new Error('The conversation changed.'))
		childMessageLifetimeRef.current = new AbortController()
		directChildNoticesRef.current.clear()
		setAgentSurface(null)
		savedSubagentsRef.current = []
		void hydrateSavedChildren()
		if (!source) {
			replaceSubagents([])
			setNarration([])
			return
		}
		const refresh = () => {
			replaceSubagents(source.getSnapshot())
			setNarration(source.getNarration?.() ?? [])
		}
		refresh()
		return source.subscribe(refresh)
	}, [hydrateSavedChildren, replaceSubagents, session, setAgentSurface])
	// The `workflow` tool's runs: their rows are projected into `subagents`, so a
	// change to a run re-reads the monitor through the same path. Runs from the
	// journals (opened by `/workflows`) ride along, read-only.
	const historicalWorkflowRunsRef = useRef<readonly WorkflowRunView[]>([])
	const publishWorkflowRuns = useCallback(() => {
		const live = session?.workflows?.runs() ?? []
		const known = new Set(live.map((run) => run.runId))
		const runs = [
			...live,
			...historicalWorkflowRunsRef.current.filter((run) => !known.has(run.runId)),
		]
		workflowRunsRef.current = runs
		setWorkflowRuns(runs)
		replaceSubagents(session?.subagents?.getSnapshot() ?? [])
	}, [replaceSubagents, session])
	useEffect(() => {
		historicalWorkflowRunsRef.current = []
		const source = session?.workflows
		if (!source) {
			workflowRunsRef.current = []
			setWorkflowRuns([])
			return
		}
		publishWorkflowRuns()
		return source.subscribe(publishWorkflowRuns)
	}, [publishWorkflowRuns, session])
	const resetSubagentActivity = useCallback(() => {
		childMessageLifetimeRef.current.abort(new Error('The owning conversation changed.'))
		childMessageLifetimeRef.current = new AbortController()
		directChildNoticesRef.current.clear()
		session?.subagents?.reset()
		session?.workflows?.reset()
		setAgentSurface(null)
		// The monitor clears its own commentary on reset; this drops the copy
		// already on screen in the same pass as the rows, so the band cannot
		// outlive the conversation it was written in.
		setNarration([])
		// A new conversation starts with no children on screen, saved ones
		// included: the evidence stays on disk, but it belongs to the runs of
		// the conversation that was just left behind.
		savedSubagentsTokenRef.current += 1
		savedSubagentsRef.current = []
		replaceSubagents([])
	}, [replaceSubagents, session, setAgentSurface])
	// Source of truth for in-flight tools (the event loop runs across renders, so
	// a ref avoids stale state); `activeTools` mirrors it for rendering.
	const activeToolsRef = useRef<readonly RunningTool[]>([])
	const clearActiveTools = useCallback(() => {
		activeToolsRef.current = []
		setActiveTools([])
	}, [])
	const permissionResolveRef = useRef<((d: PermissionDecision) => void) | null>(null)
	const permissionShownRef = useRef<PendingPermission | null>(null)
	/**
	 * The text of a refusal being typed (Tab on the No row), or `null` while the
	 * answers are shown. A ref beside the state because the key handler reads it
	 * in the tick it was set.
	 */
	const [permissionReason, setPermissionReasonState] = useState<string | null>(null)
	const permissionReasonRef = useRef<string | null>(null)
	const setPermissionReason = useCallback((next: string | null) => {
		permissionReasonRef.current = next
		setPermissionReasonState(next)
	}, [])
	const [permissionCount, setPermissionCount] = useState<AskCount | undefined>(undefined)
	/** What the terminal tells the kernel when it asks about one call at a time. */
	const perCallReviewRef = useRef<TerminalPerCallReview | null>(null)
	if (perCallReviewRef.current === null) {
		perCallReviewRef.current = createTerminalPerCallReview({
			mode: () => permissionModeRef.current,
		})
	}
	/** A plain No ended the running turn: its interruption row is still owed. */
	const refusalEndedTurnRef = useRef(false)
	/** The questions waiting on the person, one on screen at a time. */
	const permissionAsksRef = useRef<AskQueue<PendingPermission> | null>(null)
	if (permissionAsksRef.current === null) {
		permissionAsksRef.current = new AskQueue<PendingPermission>(
			(pending) => {
				setPermissionReviewOffset(0)
				setPermissionChoice(0)
				setPermissionReason(null)
				permissionShownRef.current = pending
				if (pending) {
					// Every question gets its own settle window, so a key aimed at the
					// last one cannot answer the next.
					permissionOpenedAtRef.current = Date.now()
					permissionResolveRef.current = (decision) => permissionAsksRef.current?.answer(decision)
					setPermissionDetailsOpen(!pending.summary.complete)
					setPermission(pending)
					setState('awaiting-permission')
				} else {
					permissionOpenedAtRef.current = null
					permissionResolveRef.current = null
					setPermissionDetailsOpen(false)
					setPermission(null)
					setState((current) => (current === 'awaiting-permission' ? 'thinking' : current))
				}
			},
			() => setPermissionCount(permissionAsksRef.current?.count()),
		)
	}
	const permissionAsks = permissionAsksRef.current
	/**
	 * A rule was remembered or the permission mode changed: re-check every
	 * question still open. A re-check only ever approves. The turn's own
	 * per-call questions are re-checked by the kernel (it is told here); whole
	 * batches other agents asked are re-checked below, and a question whose
	 * input was not shown in full, that leaves the turn's boundary, or that a rule
	 * or the tool itself says always needs a person stays open.
	 *
	 * Deferred a tick: the answer that caused the change is delivered first, so
	 * a re-check can never be taken for the answer to the question on screen.
	 */
	const rulesChanged = useCallback(
		(newAllows?: readonly SessionAllow[]): void => {
			queueMicrotask(() => {
				const perCallReview = perCallReviewRef.current
				perCallReview?.rulesChanged()
				const commands = session?.commandArguments
				permissionAsks.settleWhere((pending) => {
					if (pending.perCall || pending.batchOnly || pending.screenConsent) return undefined
					if (pending.withheld.length > 0 || pending.toolCalls.length === 0) return undefined
					const covered = pending.toolCalls.every((call) => {
						if (perCallReview?.modeCovers(call)) return true
						if (!newAllows || !commands) return false
						const allows = allowsFor(call, commands)
						return (
							allows?.every((allow) => newAllows.some((added) => sameAllow(added, allow))) === true
						)
					})
					return covered ? { kind: 'approve' } : undefined
				})
			})
		},
		[permissionAsks, session],
	)
	useEffect(
		() => () => {
			permissionAsks.closeAll({ kind: 'reject', feedback: 'The approval screen closed.' })
		},
		[permissionAsks],
	)

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
	// A request that waited behind a surface that hides it (the detailed
	// transcript, the rewind and resume pickers) was not seen while it waited:
	// the settle window starts again when that surface closes.
	const promptHiddenNow =
		transcriptScreen || phase === 'edit' || phase === 'resume' || phase === 'unarchive'
	const promptWasHiddenRef = useRef(false)
	useEffect(() => {
		if (promptWasHiddenRef.current && !promptHiddenNow && permissionOpenedAtRef.current !== null)
			permissionOpenedAtRef.current = Date.now()
		promptWasHiddenRef.current = promptHiddenNow
	}, [promptHiddenNow])
	// What the folder's own config pre-approves, read once for the gate.
	const trustGrants = useMemo(() => readFolderGrants(trustedCwdRef.current), [])
	// SDK-backed conversation persistence (DiskSessionStore). `scopeRef` carries
	// the active session id used by query() — mutated in place on /resume so new
	// turns attribute to the resumed conversation.
	const sessionsRef = useRef<CliSessions | null>(null)
	const scopeRef = useRef<SessionScope | null>(null)
	// What the conversation is called: the name a person gave it, else the title
	// the small model wrote. They feed the terminal title; `/resume` reads the same
	// two from the log.
	const [conversationNames, setConversationNames] = useState<{
		readonly named?: string
		readonly generated?: string
	}>({})
	const namesSessionRef = useRef<string | undefined>(undefined)
	// A conversation is titled once per launch: the first message asks, and a
	// failed ask frees the next message to try again.
	const generatedTitleAttemptedRef = useRef(new Set<string>())
	// A title written by the model while a turn held the log; saved when the turn ends.
	const pendingGeneratedTitleRef = useRef<
		{ readonly sessionId: SessionId; readonly title: string } | undefined
	>(undefined)
	const lastTerminalTitleRef = useRef<string | undefined>(undefined)
	/**
	 * Scheduled jobs and session loops (`./schedule/`). Built once; what it
	 * reads later — the transcript writer, the question and permission
	 * screens, the submit path, the session's model — is filled in each
	 * render through `scheduleLiveRef`.
	 */
	const scheduleLiveRef = useRef<{
		say: (text: string) => void
		ask: QuestionFn
		review: (request: ScheduleReviewRequest, signal?: AbortSignal) => Promise<ScheduleReviewAnswer>
		askPermission: ScreenPermissionFn
		submit: (text: string, createdBy: 'model' | 'operator') => void
		model?: { readonly provider: string; readonly model?: string }
	} | null>(null)
	const scheduleRef = useRef<ScheduleIntegration | null>(null)
	const sourceDeliveryViewRef = useRef<SourceDeliveryView | null>(null)
	if (sourceDeliveryViewRef.current === null)
		sourceDeliveryViewRef.current = new SourceDeliveryView()
	const sourceDeliveryPollRef = useRef<() => void>(() => {})
	const sourceDeliveryIssueRef = useRef<string | null>(null)
	if (scheduleRef.current === null) {
		scheduleRef.current = createScheduleIntegration({
			home: () => sessionsRef.current?.root ?? resolveNamzuHome(),
			cwd: () => ctxRef.current.cwd,
			extraRoots: () => ctxRef.current.additionalDirectories ?? [],
			config: () => ctxRef.current,
			model: () => scheduleLiveRef.current?.model,
			sessionId: () =>
				conversationMaterializedRef.current ? scopeRef.current?.sessionId : undefined,
			sourceConversation: () =>
				sourceConversationBinding(
					sessionsRef.current,
					scopeRef.current,
					conversationMaterializedRef.current,
				),
			loopsFile: () => {
				const sessions = sessionsRef.current
				const scope = scopeRef.current
				if (!sessions || !scope || !conversationMaterializedRef.current) return undefined
				try {
					return join(sessions.paths.sessionDir({ sessionId: scope.sessionId }), 'loops.json')
				} catch {
					return undefined
				}
			},
			isIdle: () => stateRef.current === 'idle' && abortRef.current === null,
			say: (text) => scheduleLiveRef.current?.say(text),
			ask: (question, signal) =>
				scheduleLiveRef.current?.ask(question, signal) ??
				Promise.resolve({ kind: 'skip' as const }),
			review: (request, signal) =>
				scheduleLiveRef.current?.review(request, signal) ?? Promise.resolve('cancel' as const),
			askPermission: (request) =>
				scheduleLiveRef.current?.askPermission(request) ??
				Promise.resolve({
					kind: 'reject' as const,
					feedback: 'Nobody can answer yet.',
				}),
			submit: (text, createdBy) => scheduleLiveRef.current?.submit(text, createdBy),
		})
	}
	/**
	 * `save_skill`'s confirmation. The tool is the TUI's alone (never exec, a
	 * scheduled run or a sub-agent), and its question is this screen, not the
	 * permission gate, so no permission mode answers it for the operator.
	 */
	const [saveSkillPrompt, setSaveSkillPromptState] = useState<{
		readonly request: SaveSkillRequest
		readonly resolve: (answer: SaveSkillAnswer) => void
	} | null>(null)
	const saveSkillPromptRef = useRef<typeof saveSkillPrompt>(null)
	const setSaveSkillPrompt = useCallback(
		(next: typeof saveSkillPrompt) => {
			if (next) setJobSurface(null)
			saveSkillPromptRef.current = next
			setSaveSkillPromptState(next)
		},
		[setJobSurface],
	)
	/**
	 * `exit_plan_mode`'s approval box. Like the skill-save box it is this
	 * terminal's own screen, not the permission gate, so no permission mode
	 * answers it for the operator.
	 */
	const [planPrompt, setPlanPromptState] = useState<{
		readonly request: PlanApprovalRequest
		readonly resolve: (answer: PlanApprovalAnswer) => void
	} | null>(null)
	const planPromptRef = useRef<typeof planPrompt>(null)
	const setPlanPrompt = useCallback(
		(next: typeof planPrompt) => {
			if (next) setJobSurface(null)
			planPromptRef.current = next
			setPlanPromptState(next)
		},
		[setJobSurface],
	)
	const [scheduleReviewPrompt, setScheduleReviewPromptState] = useState<{
		readonly token: number
		readonly request: ScheduleReviewRequest
		readonly resolve: (answer: ScheduleReviewAnswer) => void
	} | null>(null)
	const scheduleReviewTokenRef = useRef(0)
	const scheduleReviewPromptRef = useRef<typeof scheduleReviewPrompt>(null)
	const setScheduleReviewPrompt = useCallback(
		(next: typeof scheduleReviewPrompt) => {
			if (next) setJobSurface(null)
			scheduleReviewPromptRef.current = next
			setScheduleReviewPromptState(next)
		},
		[setJobSurface],
	)
	/**
	 * `ask_user_question` as a card: several questions in one call, or one that
	 * takes several answers. A lone single choice stays the plain chooser.
	 */
	const [questionDialog, setQuestionDialogState] = useState<{
		readonly token: number
		readonly question: UserQuestion
	} | null>(null)
	const questionDialogRef = useRef<typeof questionDialog>(null)
	const questionDialogTokenRef = useRef(0)
	const setQuestionDialog = useCallback(
		(next: typeof questionDialog) => {
			if (next) setJobSurface(null)
			questionDialogRef.current = next
			setQuestionDialogState(next)
		},
		[setJobSurface],
	)
	const saveSkillNotifyRef = useRef<(() => void) | null>(null)
	const saveSkillToolRef = useRef<ReturnType<typeof buildSaveSkillTool> | null>(null)
	if (saveSkillToolRef.current === null) {
		saveSkillToolRef.current = buildSaveSkillTool({
			cwd: () => ctxRef.current.cwd,
			config: () => ctxRef.current.skills,
			sessionId: () =>
				conversationMaterializedRef.current ? scopeRef.current?.sessionId : undefined,
			confirm: (request, signal) =>
				new Promise<SaveSkillAnswer>((resolve) => {
					if (signal?.aborted) {
						resolve('cancel')
						return
					}
					const entry = {
						request,
						resolve: (answer: SaveSkillAnswer) => {
							signal?.removeEventListener('abort', onAbort)
							// The screen answers from its own key handler, which Ink calls
							// before App's (a child subscribes first). Clearing the ref now
							// would hand the same Esc or Ctrl+C to App, which reads it as
							// an interrupt of the turn this answer is for. Let the key's
							// dispatch finish first.
							queueMicrotask(() => {
								if (saveSkillPromptRef.current === entry) setSaveSkillPrompt(null)
							})
							resolve(answer)
						},
					}
					const onAbort = () => entry.resolve('cancel')
					signal?.addEventListener('abort', onAbort, { once: true })
					setSaveSkillPrompt(entry)
					saveSkillNotifyRef.current?.()
				}),
			saved: ({ name, path }) =>
				scheduleLiveRef.current?.say(
					`Saved skill ${name} to ${homePath(path)}. The model is offered it from the next reply; /skills ${name} activates it now.`,
				),
		})
	}
	/**
	 * A provider session can be ready before a person has started a conversation.
	 * The scope still needs a mutable session cursor, but its generated id is
	 * provisional until the first admitted prompt or an explicit conversation
	 * operation publishes the durable Session.
	 */
	const conversationMaterializedRef = useRef(false)
	const materializationRef = useRef<Promise<SessionScope | undefined> | null>(null)
	/**
	 * The session owns processes — MCP servers, background jobs, the hooks'
	 * `session_end` — and Ink's exit does not close it. So the session is
	 * closed first, bounded, and the process leaves after: a server started
	 * with `run_in_background` used to outlive `/exit`, and a `session_end`
	 * hook never ran.
	 */
	const closeAndExit = useCallback(() => {
		cancelPendingModelSwitch()
		peersRef.current?.setEnabled(false)
		const closing = Promise.all([session?.close(), peersRef.current?.close()])
		const bounded = Promise.race([
			closing,
			new Promise<void>((resolve) => setTimeout(resolve, SESSION_CLOSE_ON_EXIT_MS).unref?.()),
		])
		void bounded.catch(() => undefined).finally(() => exit())
	}, [cancelPendingModelSwitch, exit, session])
	const exitWithSummary = useCallback(() => {
		onExitSummary?.({
			...(palDefinitionRef.current ? { palId: palDefinitionRef.current.id } : {}),
			...(conversationMaterializedRef.current && scopeRef.current?.sessionId
				? { conversationId: scopeRef.current.sessionId }
				: {}),
		})
		closeAndExit()
	}, [closeAndExit, onExitSummary])
	/**
	 * The first Ctrl+C (with nothing to interrupt) or Ctrl+D (on an empty
	 * composer) arms exit and says so in the footer for 800 ms; the same key
	 * again inside that window exits. Nothing is written to the transcript, so
	 * nothing is left behind in the scrollback after the exit.
	 */
	const [exitHint, setExitHint] = useState<'Ctrl-C' | 'Ctrl-D' | null>(null)
	const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	/** The footer's notice slot: one passing notice at a time, see notifications.ts. */
	const notices = useNotifications()
	/** A compaction hides the context meter until the next turn starts. */
	const [contextHidden, setContextHidden] = useState(false)
	const contextHiddenRef = useRef(false)
	contextHiddenRef.current = contextHidden
	/** The idle compactor, once it exists, for what a rewrite of the history must tell it. */
	const idleCompactionRef = useRef<{ contextTokens: { current: number | undefined } } | null>(null)
	const contextTokens = usage?.context?.tokens
	const contextWindow = usage?.context?.windowTokens
	const addNotice = notices.add
	const removeNotice = notices.remove
	useEffect(() => {
		const meter =
			contextHidden || contextTokens === undefined || contextWindow === undefined
				? null
				: contextMeter({
						tokens: contextTokens,
						windowTokens: contextWindow,
						// The CLI's strategies (structured, salience) both summarise on their own.
						autoCompact: true,
					})
		if (meter) addNotice(contextNotice(meter))
		else removeNotice(CONTEXT_NOTICE_KEY)
	}, [contextHidden, contextTokens, contextWindow, addNotice, removeNotice])
	const armExit = useCallback(
		(keyName: 'Ctrl-C' | 'Ctrl-D') => {
			if (exitArmedRef.current === keyName) {
				if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
				exitTimerRef.current = null
				exitArmedRef.current = null
				setExitHint(null)
				exitWithSummary()
				return
			}
			if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
			exitArmedRef.current = keyName
			setExitHint(keyName)
			exitTimerRef.current = setTimeout(() => {
				exitTimerRef.current = null
				exitArmedRef.current = null
				setExitHint(null)
			}, EXIT_HINT_MS)
		},
		[exitWithSummary],
	)
	useEffect(
		() => () => {
			if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
		},
		[],
	)
	/** Durable active state is not permission to spend turns after a restart. */
	const [goalActivation] = useState(() => new SessionGoalActivation())
	const goalDriveInFlightRef = useRef(false)
	const [goalDriveVersion, setGoalDriveVersion] = useState(0)
	const [goalStatus, setGoalStatus] = useState<SessionGoal | null>(null)
	const pendingGoalResumeRef = useRef<string | null>(null)
	/**
	 * The conversation `namzu resume <id>` opened, until the screen is ready to
	 * look at it once: a scheduled run parked on a decision there is continued
	 * then, so its permission prompt is on screen without typing `/resume`.
	 */
	const pendingScheduledResumeRef = useRef<string | null>(null)
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
	const peersRef = useRef<LivePeers | null>(null)
	const peersStartingRef = useRef(false)
	const [peerVersion, wakePeers] = useState(0)
	const peerTools = useMemo(() => buildPeerTools(() => peersRef.current), [])
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
	const [externalEditorRequest, setExternalEditorRequest] = useState<PendingExternalEditor | null>(
		null,
	)
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
	// Reset the transcript view: clear the terminal + remount <Static> so its
	// already-printed lines don't linger above fresh content (/clear,
	// /clear-screen, /resume).
	//
	// The block numbering resets with it and needs no separate step: the numbers
	// live on the rows, so emptying `messages` takes them with it.
	const resetTranscript = useCallback(
		(options: { preserveTranscriptScreen?: boolean } = {}) => {
			if (stdout.isTTY) writeStdout('\x1b[2J\x1b[3J\x1b[H')
			if (!options.preserveTranscriptScreen) setTranscriptScreen(false)
			// The scrollback floor goes with the log it counted. <Static> is remounted
			// by the key below and has emitted nothing again; a floor that survived
			// would keep the next conversation's rows out of the live window.
			settledRef.current = 0
			setResetKey((k) => k + 1)
		},
		[stdout.isTTY, writeStdout],
	)

	// The scroll view grows the live frame to nearly the screen height, and
	// closing it shrinks the frame back. Either way Ink repaints the frame in
	// place rather than reprinting it, so a band is left unpainted: on open the
	// taller frame leaves it at the TOP (the live region is bottom-anchored by
	// `ViewportBound`, so the top is what gives way to the growth), and on close
	// the shorter frame strands the composer near the top with blank rows under
	// it. Rebuild the transcript the way a resize does (clear, remount <Static>,
	// reprint once) on EITHER transition so the screen is tidy. Open used to go
	// unhandled, which is what left the blank band above a scrolled transcript.
	const scrollWasOpenRef = useRef(false)
	useEffect(() => {
		const wasOpen = scrollWasOpenRef.current
		const open = scrollOpen || transcriptScreen
		scrollWasOpenRef.current = open
		if (wasOpen !== open) resetTranscript({ preserveTranscriptScreen: true })
	}, [scrollOpen, transcriptScreen, resetTranscript])

	const previousTerminalRef = useRef(terminal)
	useEffect(() => {
		const previous = previousTerminalRef.current
		previousTerminalRef.current = terminal
		if (
			externalEditorRequestRef.current === null &&
			(terminal.columns !== previous.columns ||
				terminal.rows < previous.rows ||
				((scrollOpen || transcriptScreen) && terminal.rows !== previous.rows))
		) {
			// A contraction can move live rows into native scrollback before Ink
			// receives resize; expansion leaves already-printed Static rows wrapped
			// at their old width. A pure height expansion needs no rebuild normally,
			// but WHILE SCROLLED the frame is near-full-screen and grows in place
			// with the same top-blank the open transition has, so rebuild on any
			// height change in that mode. Rebuild the normal-buffer transcript at
			// the new width, retaining messages, draft and selected child. Regular
			// frames remain incremental.
			resetTranscript({ preserveTranscriptScreen: true })
		}
	}, [terminal, resetTranscript, scrollOpen, transcriptScreen])

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
					new ExternalEditorError('wait for the current reply and queued messages to finish'),
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

	const flushLaunchReceiptsRef = useRef<() => void>(() => {})
	/**
	 * What the model has reasoned since the last row was written. The next
	 * assistant or tool row takes it, so the detailed transcript screen can
	 * draw it above that row; no other view shows it.
	 */
	const thinkingForNextRowRef = useRef('')
	const pushMessage = useCallback(
		(
			role: TranscriptMessage['role'],
			content: string,
			pending = false,
			glyph?: string,
			detail?: readonly string[],
			glyphColor?: string,
			meta?: string,
			activity?: TranscriptMessage['activity'],
			sourceDelivery?: true,
			shell?: ShellOutput,
			diff?: TranscriptMessage['diff'],
			contentColor?: string,
		) => {
			// A reply's text belongs after the receipt of the agents its turn
			// launched, so a receipt still waiting out its settle window is
			// written before the first word of a reply.
			if (role === 'assistant') flushLaunchReceiptsRef.current()
			// Anything written after a run of reads and searches ends the run.
			// Empty text from the model folds into the open line rather than ending it.
			if (!(role === 'assistant' && !pending && content.trim().length === 0))
				readSearchGroup.close()
			// One mapping for every system row: a caller that names no glyph gets
			// the dim notice dot, so no producer can bypass `systemRowStyle`.
			const noticeStyle =
				role === 'system' && glyph === undefined && !pending ? systemRowStyle('notice') : undefined
			const rowGlyph = noticeStyle ? noticeStyle.glyph : glyph
			const rowGlyphColor = glyphColor ?? noticeStyle?.color
			const id = nextId()
			let thinkingText: string | undefined
			if (
				(role === 'assistant' || role === 'tool') &&
				thinkingForNextRowRef.current.trim() !== ''
			) {
				thinkingText = thinkingForNextRowRef.current
				thinkingForNextRowRef.current = ''
			}
			const candidate = { role, content, pending, glyph: rowGlyph, detail, activity }
			setMessages((prev) =>
				// The notice layer, not each caller, keeps a notice from printing
				// twice in a row: the same sentence twice reads as two events.
				isRepeatedNotice(prev.at(-1), candidate)
					? prev
					: [
							...prev,
							{
								id,
								role,
								content,
								pending,
								glyph: rowGlyph,
								detail,
								glyphColor: rowGlyphColor,
								meta,
								activity,
								...(thinkingText !== undefined ? { thinking: thinkingText } : {}),
								...(shell ? { shell } : {}),
								...(diff ? { diff } : {}),
								...(contentColor ? { contentColor } : {}),
								...(sourceDelivery ? { sourceDelivery } : {}),
								// Numbered only if this body will actually be COLLAPSED — the
								// number exists to be read off a hint, and a body that fits
								// prints no hint. Numbering every body instead would count blocks
								// no hint ever named.
								//
								// Derived from `prev` rather than a counter, so the number is a
								// fact about the transcript rather than a second record of it.
								...((activity && detail?.length) || messageCollapses({ detail, shell, diff })
									? {
											detailRef: prev.filter((m) => m.detailRef !== undefined).length + 1,
										}
									: {}),
							},
						],
			)
			return id
		},
		[nextId, readSearchGroup],
	)
	/**
	 * Every system row except the two `✻` lines goes through here: the level
	 * picks the dot's colour, and a second line, when there is one, hangs
	 * under the dot as `⎿`. No caller chooses a glyph of its own.
	 */
	const pushSystem = useCallback(
		(
			level: SystemLevel,
			content: string,
			options?: {
				readonly detail?: readonly string[]
				readonly meta?: string
				readonly continuation?: string
			},
		) => {
			const style = systemRowStyle(level)
			const id = pushMessage(
				'system',
				content,
				false,
				style.glyph,
				options?.detail,
				style.color,
				options?.meta,
			)
			if (options?.continuation)
				pushMessage(
					'system',
					options.continuation,
					false,
					CONTINUATION_GLYPH,
					undefined,
					tokenColor('text.muted'),
				)
			return id
		},
		[pushMessage],
	)
	/** Write a row a shared builder produced, as `pushMessage` writes a live one. */
	const pushRow = useCallback(
		(row: ToolRow) =>
			pushMessage(
				row.role,
				row.content,
				false,
				row.glyph,
				row.detail,
				row.glyphColor,
				row.meta,
				row.activity,
				undefined,
				row.shell,
				row.diff,
				row.contentColor,
			),
		[pushMessage],
	)
	/**
	 * Stopping background agents is the operator's act, so the model is told once,
	 * with its next turn and without waking it: one note for however many.
	 */
	const tellModelAgentsStopped = useCallback((stopped: readonly SubagentActivity[]) => {
		const note = stoppedByUserNote(stopped.map((agent) => agent.description || agent.agentId))
		if (note === undefined) return
		directChildNoticesRef.current.set(++directChildNoticeIdRef.current, {
			context: note,
			label: note,
			kind: 'advisory',
		})
	}, [])
	/**
	 * The operator stops every background agent still going: the model is told
	 * once, the conversation gets the one row that says so, and nothing else is
	 * written for the stop. The agents' own end rows and the turn's closing line
	 * would only repeat it (or split it), so they are marked as already said.
	 */
	const stopBackgroundAgentsByOperator = useCallback(
		(stopped: readonly SubagentActivity[], notice: string) => {
			tellModelAgentsStopped(stopped)
			for (const agent of stopped) {
				reportedAgentsRef.current.add(agent.viewId)
				session?.stopSubagent?.(agent.viewId)
			}
			const wait = closingWaitRef.current
			if (wait !== null) closingWaitRef.current = { ...wait, silent: true }
			pushMessage(
				'system',
				notice,
				false,
				systemRowStyle('error').glyph,
				undefined,
				systemRowStyle('error').color,
			)
		},
		[pushMessage, session, tellModelAgentsStopped],
	)
	/**
	 * The stop-all chord (ctrl+x ctrl+k), from the composer or the rail: nothing
	 * running says so, the first press arms a 3 s confirm, the second stops every
	 * background agent still going and says how many.
	 */
	const requestStopAllAgents = useCallback(() => {
		const running = stoppableBackgroundAgents(railRowsRef.current)
		const armed = stopAllArmedRef.current !== null
		const step = stopAllStep(running.length, armed)
		if (stopAllArmedRef.current !== null) {
			clearTimeout(stopAllArmedRef.current)
			stopAllArmedRef.current = null
		}
		notices.remove(STOP_ALL_CONFIRM_KEY)
		if (step.kind === 'stop') {
			stopBackgroundAgentsByOperator(running, step.notice)
			return
		}
		// "Nothing running" and "press again" are footer feedback that times out
		// (2 s and 3 s), never a
		// transcript row.
		notices.add({
			key: step.kind === 'arm' ? STOP_ALL_CONFIRM_KEY : 'kill-agents-none',
			text: step.notice,
			priority: 'immediate',
			timeoutMs: step.footerMs,
		})
		if (step.kind === 'arm') {
			// The second press is only a confirmation inside this window.
			const timer = setTimeout(() => {
				stopAllArmedRef.current = null
			}, step.footerMs)
			timer.unref?.()
			stopAllArmedRef.current = timer
		}
	}, [stopBackgroundAgentsByOperator, notices])
	useEffect(
		() =>
			session?.onSubagentReport?.((report) => {
				if (
					previousSessionRef.current !== session ||
					scopeRef.current?.sessionId !== report.parentSessionId
				)
					return
				const label = 'Child follow-up ended. Its report is available to the parent.'
				directChildNoticesRef.current.set(++directChildNoticeIdRef.current, {
					context: report.text,
					label,
					kind: 'task-completion',
				})
				activeTurnInboxRef.current?.notify()
				// The model hears it; the person sees the agent's own notice line.
			}),
		[session],
	)
	// A running agent can say something to the conversation with its own
	// `send_message`. The person sees a collapsed `› Message from @name` row; the
	// model gets the text with its next turn, or an idle session wakes for it.
	useEffect(() => {
		childMessagesRef.current = new Map()
		return session?.onSubagentMessage?.((message) => {
			if (
				previousSessionRef.current !== session ||
				scopeRef.current?.sessionId !== message.parentSessionId
			)
				return
			const row = childMessageRow(message)
			pushMessage(
				'tool',
				row.content,
				false,
				'›',
				row.detail,
				tokenColor('text.muted'),
				row.hint,
				'agent-result',
			)
			childMessagesRef.current.set(++childMessageIdRef.current, childMessageNotice(message))
			// No `notify()`: a message queued for the next turn does not release a wait the
			// running turn is in (it is queued at `next` priority); the turn
			// takes it at its next request boundary, an idle session wakes for it below.
			setNoticeVersion((version) => version + 1)
		})
	}, [session, pushMessage])
	// A background agent that ends after the turn that launched it was over: the
	// model hears it with the next turn, or an idle session wakes for it. Every
	// agent that ended meanwhile joins the one wake (they share `childMessagesRef`,
	// which the wake empties into a single message). The operator's own stop is
	// not news; the stop key tells the model once, itself.
	useEffect(
		() =>
			session?.onSubagentCompletion?.((completion) => {
				if (
					previousSessionRef.current !== session ||
					scopeRef.current?.sessionId !== completion.parentSessionId ||
					completion.stoppedBy === 'user'
				)
					return
				childMessagesRef.current.set(++childMessageIdRef.current, completion.text)
				setNoticeVersion((version) => version + 1)
			}),
		[session],
	)
	/**
	 * A turn that ended over background agents still running. Its closing line is
	 * written when they end, with the wait counted; until then one dim line names
	 * what is pending.
	 */
	const closingWaitRef = useRef<{
		readonly since: number
		readonly pausedMs: number
		readonly lastEndedAt: number
		/** The operator stopped the agents: the wait ends without a line of its own. */
		readonly silent?: boolean
	} | null>(null)
	const [closingWaitVersion, setClosingWaitVersion] = useState(0)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the version is what moves; the ref holds the wait.
	useEffect(() => {
		closingWaitRef.current = null
		setClosingWaitVersion((version) => version + 1)
	}, [session])
	// The agents ended: write the closing line the turn was holding, with the
	// wait counted. Only between turns, so it never lands inside a streaming reply.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the version moves with the ref.
	useEffect(() => {
		const wait = closingWaitRef.current
		if (wait === null || state !== 'idle') return
		const mine = subagents.filter(
			(agent) =>
				agent.replayed !== true && !isWorkflowRunAgent(agent) && agent.startedAt >= wait.since,
		)
		if (pendingBackgroundAgents(mine, isWorkflowRunAgent).length > 0) return
		if (workflowRuns.some((run) => run.status === 'running')) return
		closingWaitRef.current = null
		setClosingWaitVersion((version) => version + 1)
		if (wait.silent === true) return
		const line = settleLine(Math.max(0, Date.now() - wait.since - wait.pausedMs), mine, new Date())
		if (line) pushMessage('system', line, false, CLOSING_GLYPH, undefined, tokenColor('text.muted'))
	}, [subagents, workflowRuns, state, closingWaitVersion, pushMessage])
	/** The queue row chosen for editing with Up; null when no row is chosen. */
	const [queueSelection, setQueueSelectionState] = useState<number | null>(null)
	const queueSelectionRef = useRef<number | null>(null)
	const setQueueSelection = useCallback((next: number | null) => {
		queueSelectionRef.current = next
		setQueueSelectionState(next)
	}, [])
	const takeQueuedPrompt = useCallback(
		(index: number) => {
			const pending = queuedRef.current
			const prompt = pending[index]
			if (!isRecallableHumanPrompt(prompt)) return null
			const remaining = [...pending.slice(0, index), ...pending.slice(index + 1)]
			replaceQueued(remaining)
			if (remaining.length === 0) setQueuePause(null)
			setQueueSelection(null)
			return {
				text: prompt.recallText ?? prompt.text,
				...(prompt.attachments ? { attachments: prompt.attachments } : {}),
				...(prompt.triggers ? { triggers: prompt.triggers } : {}),
			}
		},
		[replaceQueued, setQueuePause, setQueueSelection],
	)
	const recallQueuedPrompt = useCallback(() => {
		const pending = queuedRef.current
		let index = pending.length - 1
		while (index >= 0 && !isRecallableHumanPrompt(pending[index])) index -= 1
		if (index < 0) {
			pushMessage('system', 'No queued message to edit.')
			return null
		}
		return takeQueuedPrompt(index)
	}, [pushMessage, takeQueuedPrompt])
	/**
	 * Up/Down on an empty composer walks the queued messages the operator can
	 * still edit. Returns whether the key was used, so Up falls through to the
	 * prompt history when there is nothing to select.
	 */
	const moveQueueSelection = useCallback(
		(direction: 'up' | 'down'): boolean => {
			const editable = queuedRef.current.flatMap((prompt, index) =>
				isRecallableHumanPrompt(prompt) ? [index] : [],
			)
			const current = queueSelectionRef.current
			if (direction === 'up') {
				if (editable.length === 0) return false
				const older = current === null ? undefined : editable.filter((i) => i < current).at(-1)
				setQueueSelection(current === null ? (editable.at(-1) ?? null) : (older ?? current))
				return true
			}
			if (current === null) return false
			setQueueSelection(editable.find((i) => i > current) ?? null)
			return true
		},
		[setQueueSelection],
	)
	const loadSelectedQueued = useCallback(() => {
		const index = queueSelectionRef.current
		return index === null ? null : takeQueuedPrompt(index)
	}, [takeQueuedPrompt])
	// A chosen queue row goes with the message it pointed at (sent, recalled, dropped).
	useEffect(() => {
		const index = queueSelectionRef.current
		if (index !== null && !isRecallableHumanPrompt(queued[index])) setQueueSelection(null)
	}, [queued, setQueueSelection])

	/**
	 * The skill proposal's per-conversation facts: whether this conversation
	 * has proposed one, and whether it has used a skill. Keyed by the
	 * conversation generation, so `/clear`, `/resume` and a fork start over.
	 */
	const learningRef = useRef({
		generation: -1,
		proposed: false,
		skillUsed: false,
	})
	/** `/skills save off|on` in this session, over whatever the config files say. */
	const skillSuggestOverrideRef = useRef<boolean | undefined>(undefined)
	/** `/config triggers on|off` in this session, over whatever the config files say. */
	const [composerTriggersOverride, setComposerTriggersOverride] = useState<boolean | undefined>()
	const composerTriggerSettings = useMemo(
		() => resolveComposerTriggers(ctx.composerTriggers),
		[ctx.composerTriggers],
	)
	const composerTriggerRegistry = useMemo(
		() =>
			compileRegistry(BUILTIN_TRIGGERS, {
				arming: composerTriggerSettings.arming,
				locales: composerTriggerSettings.languages,
			}),
		[composerTriggerSettings],
	)
	const composerTriggersOn = composerTriggersOverride ?? composerTriggerSettings.enabled

	// The theme the printed transcript was drawn in. Rows already in scrollback keep the colours they
	// were printed with, so a theme that is saved reprints the transcript, the way a resize does.
	const printedThemeRef = useRef(shownTheme())
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the signal that <Static> printed again.
	useEffect(() => {
		printedThemeRef.current = shownTheme()
	}, [resetKey])
	const applyThemeChoice = useCallback(
		(setting: ThemeSetting) => {
			pushMessage('system', saveTheme(setting))
			if (shownTheme() !== printedThemeRef.current)
				resetTranscript({ preserveTranscriptScreen: true })
		},
		[pushMessage, resetTranscript],
	)
	// The picker's highlighted row is shown while it is open; closing it for any reason drops the preview.
	useEffect(() => {
		setThemePreview(
			choicePicker?.kind === 'theme' ? choicePicker.values[selectedChoice] : undefined,
		)
	}, [choicePicker, selectedChoice])
	/** `/config recap on|off` in this session, over whatever the config files and environment say. */
	const [recapOverride, setRecapOverride] = useState<boolean | undefined>()
	const recapOn =
		recapOverride ?? recapEnabled({ env: process.env, tui: initialCtx.tui, interactive: true })
	const recapOnRef = useRef(recapOn)
	recapOnRef.current = recapOn
	/** `/config tips on|off` in this session, over whatever the config files say. */
	const [spinnerTipsOverride, setSpinnerTipsOverride] = useState<boolean | undefined>()
	const spinnerTipsOn = spinnerTipsOverride ?? ctx.tui?.spinnerTips !== false
	/** Tool calls the reply in flight has made; the tip picker reads and clears it at the reply's end. */
	const turnToolCallsRef = useRef(0)
	const spinnerTip = useSpinnerTip({
		store: tipHistory,
		enabled: spinnerTipsOn,
		busy: state !== 'idle',
		statusLineSet: ctx.statusLine !== undefined,
		notificationsSet: ctx.tui?.notifications !== undefined,
		lastTurnToolCalls: () => {
			const calls = turnToolCallsRef.current
			turnToolCallsRef.current = 0
			return calls
		},
	})
	/**
	 * Whether the model can run `skill-creator` here, which save-as-skill
	 * needs. Read once for the tag row; read again when a turn starts and when
	 * its follow-up would run, in case the skills changed meanwhile.
	 */
	const readSkillCreator = useCallback((): boolean => {
		try {
			const creator = discoverSkills({
				cwd: ctx.cwd,
				...(ctx.skills ? { config: ctx.skills } : {}),
			}).find((skill) => skill.name === SKILL_CREATOR_SKILL)
			return Boolean(creator && !creator.problem && creator.invocation !== 'operator')
		} catch {
			return false
		}
	}, [ctx.cwd, ctx.skills])
	const skillCreatorAvailable = useMemo(() => readSkillCreator(), [readSkillCreator])
	/** The session as the triggers see it right now, for a check at a turn's start or end. */
	const triggerContextNow = useCallback(
		(): TriggerContext => ({
			permissionMode: permissionModeRef.current,
			sessionHypermode: hypermodeRef.current,
			effortMenu: (session?.reasoningEffortLevels?.length ?? 0) > 0,
			// The interactive session always mounts `Agent` and the `schedule`
			// tool; only scheduled runs withhold them, and those never read
			// composer triggers.
			agentTool: true,
			skillCreator: readSkillCreator(),
			scheduleTool: true,
		}),
		[readSkillCreator, session],
	)
	/** A turn's hand-off to its after-turn triggers; assigned below, where the queue lives. */
	const triggerFollowUpsRef = useRef<
		| ((
				st: StreamState,
				ending: 'completed' | 'stopped' | 'paused' | 'cancelled' | 'failed',
		  ) => boolean)
		| null
	>(null)
	const conversationLearning = useCallback(() => {
		if (learningRef.current.generation !== conversationGenRef.current) {
			learningRef.current = {
				generation: conversationGenRef.current,
				proposed: false,
				skillUsed: false,
			}
		}
		return learningRef.current
	}, [])
	/**
	 * After a turn settles: one dim line proposing to save it as a skill, when
	 * the turn earned it (`judgeSkillSuggestion`) and the anti-nag ledger lets
	 * it through. Costs nothing and saves nothing; `/skills save` does that.
	 */
	const offerSkillSuggestion = useCallback(
		(st: StreamState) => {
			if (!st.learning) return
			const conversation = conversationLearning()
			const config = ctxRef.current.skills
			const verdict = judgeSkillSuggestion(st.learning, {
				suggest: skillSuggestOverrideRef.current ?? config?.suggest,
				...(config?.suggestMinToolCalls !== undefined
					? { minToolCalls: config.suggestMinToolCalls }
					: {}),
				planMode: st.startedInPlanMode === true || permissionModeRef.current === 'plan',
				skillUsedInConversation: conversation.skillUsed,
				proposedInConversation: conversation.proposed,
				skillFlowTurn: st.skillFlow === true,
			})
			if (!verdict.suggest) return
			const home = resolveNamzuHome()
			const admission = admitSuggestion(readSuggestionLedger(home))
			if (admission.show === 'nothing') return
			conversation.proposed = true
			writeSuggestionLedger(home, admission.next)
			pushMessage(
				'system',
				admission.show === 'proposal'
					? skillSuggestionNotice(verdict.steps, verdict.tools)
					: SUGGESTIONS_STOPPED_NOTICE,
				false,
				'✻',
				undefined,
				tokenColor('text.muted'),
			)
		},
		[conversationLearning, pushMessage],
	)

	/**
	 * `/agents [running|available|batches]`, answered by the delegation UI's
	 * `agentsSlashCommand` over this session's live monitor and the batches the
	 * session index holds. A `batches` answer opens a picker immediately with a
	 * disabled loading row, then replaces it once the listing resolves; the
	 * composer stays reachable the whole time. A stale read is dropped by
	 * comparing `choicePickerRef.current` against the exact loading-picker
	 * object this call put there.
	 */
	const runAgentsCommand = useCallback(
		(args: readonly string[], openCockpit: () => void, listAvailable: () => void): void => {
			const wantsBatches = args.length === 1 && args[0] === 'batches'
			const pending: ChoicePickerState | undefined = wantsBatches
				? {
						kind: 'agent-batches',
						title: 'Batches',
						values: ['loading'],
						options: [
							{
								label: 'Loading…',
								description: 'Reading saved batches…',
								// A disabled row shows its reason in place of its description.
								disabledReason: 'Reading saved batches…',
							},
						],
					}
				: undefined
			if (pending) {
				setSelectedChoice(0)
				setChoicePicker(pending)
			}
			void (async () => {
				const result = await agentsSlashCommand(args, {
					liveAgents: () => subagentsRef.current,
					...(session?.listSavedBatches ? { savedBatches: session.listSavedBatches } : {}),
				})
				if (appLifetime.signal.aborted) return
				if (pending && choicePickerRef.current !== pending) return
				switch (result.kind) {
					case 'agent-cockpit':
						openCockpit()
						return
					case 'available-agents':
						listAvailable()
						return
					case 'message':
						if (pending) setChoicePicker(null)
						pushMessage('system', result.content)
						return
					case 'batches':
						setChoicePicker({
							kind: 'agent-batches',
							title: 'Batches',
							notice:
								result.listing.omitted > 0
									? `${result.listing.omitted} older batch${result.listing.omitted === 1 ? '' : 'es'} not shown.`
									: undefined,
							values: result.listing.batches,
							options: result.listing.batches.map(batchOption),
						})
						return
				}
			})()
		},
		[appLifetime, pushMessage, session, setChoicePicker, setSelectedChoice],
	)
	/**
	 * Opens an `/agents batches` selection straight into its first agent's
	 * transcript — where the replayed banner actually lives, for a finished
	 * batch — rather than the phase/agent list Ctrl+T lands on.
	 *
	 * A finished batch's children are hydrated from their logs first, since a
	 * batch this operator has not opened the cockpit for yet may not be in
	 * `subagents` at all. A live batch skips that: it is already there.
	 */
	const openBatch = useCallback(
		async (batch: Batch): Promise<void> => {
			if (!batch.live) await hydrateSavedChildren()
			const workflow = agentWorkflows(subagentsRef.current, workflowRunsRef.current).find(
				(candidate) => candidate.agents.some((agent) => agent.workflowId === batch.id),
			)
			const firstPhase = workflow?.phases[0]
			const firstAgent = firstPhase?.agents[0]
			if (!firstPhase || !firstAgent) {
				pushMessage(
					'system',
					`Could not open "${batch.name}" — its saved children are no longer available.`,
				)
				return
			}
			setAgentSurface({
				kind: 'transcript',
				selectedPhaseId: firstPhase.id,
				selectedId: firstAgent.viewId,
				returnFocus: 'agents',
				tailOffset: 0,
			})
		},
		[hydrateSavedChildren, pushMessage, setAgentSurface],
	)

	/**
	 * Delegated work writes three kinds of row into settled history (see
	 * `agent-transcript-rows.ts`): a launch receipt per batch, then one
	 * completion row per agent. Each is exactly-once, gated by its own set,
	 * and a batch's receipt is always written before any of its completions.
	 *
	 * A receipt waits until the batch is whole — no `Agent` call of the turn is
	 * still starting without a row of its own, and the newest member arrived
	 * at least {@link RECEIPT_SETTLE_MS} ago — so two agents launched in one
	 * response read as one launch rather than two. A member that already
	 * finished forces the receipt out, so it never trails its completion.
	 */
	const reportedAgentsRef = useRef(new Set<string>())
	/** The reason each failed agent was last reported with, so a repeat of it reads as `failed again`. */
	const reportedFailuresRef = useRef(new Map<string, string>())
	const reportedBatchesRef = useRef(new Set<string>())
	/** Workflows whose single group line is already in the conversation, by group id. */
	const reportedWorkflowLinesRef = useRef(new Set<string>())
	const batchSeenAtRef = useRef(new Map<string, { readonly at: number; readonly count: number }>())
	const [receiptTick, setReceiptTick] = useState(0)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => {
		reportedAgentsRef.current.clear()
		reportedFailuresRef.current.clear()
		reportedBatchesRef.current.clear()
		reportedWorkflowLinesRef.current.clear()
		batchSeenAtRef.current.clear()
	}, [session])
	// A labelled workflow gets one group line however many batches it spans.
	const claimReceipt = useCallback((members: readonly SubagentActivity[]): boolean => {
		const first = members[0]
		if (!first || first.workflow === DEFAULT_AGENT_WORKFLOW) return true
		if (reportedWorkflowLinesRef.current.has(first.workflowGroupId)) return false
		reportedWorkflowLinesRef.current.add(first.workflowGroupId)
		return true
	}, [])
	/**
	 * Writes the receipt of every batch that is whole. `force` skips the settle
	 * window (a reply is about to print under it); a batch whose `Agent` call is
	 * still starting is never written. Returns the delay after which to look
	 * again, when a batch is still settling.
	 */
	const writeLaunchReceipts = useCallback(
		(
			agents: readonly SubagentActivity[],
			tools: readonly RunningTool[],
			force: boolean,
		): number | undefined => {
			const current = session?.subagents?.getSnapshot() ?? []
			const now = Date.now()
			const batches = new Map<string, SubagentActivity[]>()
			for (const agent of agents) {
				if (agent.replayed || agent.resumed || isWorkflowRunAgent(agent)) continue
				if (!current.some((item) => item.viewId === agent.viewId)) continue
				const key = JSON.stringify([agent.workflowId, agent.batchId])
				const members = batches.get(key) ?? []
				members.push(agent)
				batches.set(key, members)
			}
			const launching = tools.some(
				(tool) =>
					tool.toolName.toLowerCase() === 'agent' &&
					!agents.some(
						(agent) =>
							agent.toolUseId === tool.id &&
							(tool.turnId === undefined || agent.workflowId === tool.turnId),
					),
			)
			let retryIn: number | undefined
			for (const [key, members] of batches) {
				if (reportedBatchesRef.current.has(key)) continue
				// Re-stamped when the batch grows: the settle window runs from its newest member.
				const previous = batchSeenAtRef.current.get(key)
				const stamp =
					previous !== undefined && previous.count === members.length ? previous.at : now
				if (stamp === now) batchSeenAtRef.current.set(key, { at: now, count: members.length })
				// A batch the turn waits on is a live group while it runs and writes its
				// one finished receipt when every member has ended.
				if (members.some((agent) => agent.background !== true) && members.some(isRunning)) continue
				const settledMember = members.some((agent) =>
					['completed', 'failed', 'cancelled'].includes(agent.status),
				)
				const waited = now - stamp
				if (!settledMember && (launching || (!force && waited < RECEIPT_SETTLE_MS))) {
					retryIn = Math.min(retryIn ?? RECEIPT_SETTLE_MS, Math.max(50, RECEIPT_SETTLE_MS - waited))
					continue
				}
				reportedBatchesRef.current.add(key)
				if (!claimReceipt(members)) continue
				pushRow(agentLaunchRow(members))
			}
			return retryIn
		},
		[claimReceipt, pushRow, session],
	)
	flushLaunchReceiptsRef.current = () => {
		writeLaunchReceipts(subagentsRef.current, activeToolsRef.current, true)
	}
	useEffect(() => {
		void receiptTick
		const current = session?.subagents?.getSnapshot() ?? []
		const retryIn = writeLaunchReceipts(subagents, activeTools, false)
		const batches = new Map<string, SubagentActivity[]>()
		for (const agent of subagents) {
			if (agent.replayed || agent.resumed || isWorkflowRunAgent(agent)) continue
			if (!current.some((item) => item.viewId === agent.viewId)) continue
			const key = JSON.stringify([agent.workflowId, agent.batchId])
			const members = batches.get(key) ?? []
			members.push(agent)
			batches.set(key, members)
		}
		for (const agent of subagents) {
			if (isWorkflowRunAgent(agent)) continue
			if (
				!current.some(
					(item) =>
						item.viewId === agent.viewId &&
						item.workflowId === agent.workflowId &&
						item.status === agent.status,
				)
			)
				continue
			// A resumed agent that is running again reports again when it ends.
			if (!['completed', 'failed', 'cancelled'].includes(agent.status)) {
				if (agent.resumed) reportedAgentsRef.current.delete(agent.viewId)
				continue
			}
			if (reportedAgentsRef.current.has(agent.viewId)) continue
			// Its receipt first, even if that means writing it alone.
			const key = JSON.stringify([agent.workflowId, agent.batchId])
			const batchMembers = batches.get(key) ?? [agent]
			// A batch the turn waits on writes its one receipt when every member has
			// ended (the receipt loop above); each member still says how it ended now.
			const batchStillLive =
				batchMembers.some((member) => member.background !== true) && batchMembers.some(isRunning)
			if (
				!agent.replayed &&
				!agent.resumed &&
				!batchStillLive &&
				!reportedBatchesRef.current.has(key)
			) {
				reportedBatchesRef.current.add(key)
				if (claimReceipt(batches.get(key) ?? [agent])) {
					pushRow(agentLaunchRow(batches.get(key) ?? [agent]))
				}
			}
			reportedAgentsRef.current.add(agent.viewId)
			const previousFailure = reportedFailuresRef.current.get(agent.viewId)
			if (agent.status === 'failed')
				reportedFailuresRef.current.set(agent.viewId, failureReason(agent))
			for (const done of agentCompletionRows(agent, previousFailure)) pushRow(done)
		}
		if (retryIn === undefined) return
		const timer = setTimeout(() => setReceiptTick((tick) => tick + 1), retryIn)
		return () => clearTimeout(timer)
	}, [subagents, activeTools, pushRow, session, receiptTick, writeLaunchReceipts, claimReceipt])

	/**
	 * A workflow leaves one closing line in the conversation, written once, when
	 * it is really over: the parent turn that ran it has ended and every member
	 * has settled. A phase that starts long after the previous one settled is
	 * the same workflow, so nothing is written between phases. A workflow is a
	 * label within one parent turn (its group id carries the turn), so a later
	 * turn's agents under the same label are a new run with their own line.
	 * Saved children never count; they ended in another process.
	 */
	const reportedWorkflowsRef = useRef(new Set<string>())
	/** Parent turns that have ended, by the id their agents carry as `workflowId`. */
	const endedWorkflowTurnsRef = useRef(new Set<string>())
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => {
		reportedWorkflowsRef.current.clear()
		endedWorkflowTurnsRef.current.clear()
	}, [session])
	const flushWorkflowNotices = useCallback((): void => {
		for (const workflow of settledWorkflows(subagentsRef.current)) {
			if (reportedWorkflowsRef.current.has(workflow.id)) continue
			if (!workflow.agents.some((agent) => endedWorkflowTurnsRef.current.has(agent.workflowId))) {
				continue
			}
			reportedWorkflowsRef.current.add(workflow.id)
			pushRow(workflowClosingRow(workflow))
		}
	}, [pushRow])
	// A member that settles after its turn ended (it was not waited for) closes the workflow then.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `subagents` is what moves; the flush reads the ref it mirrors.
	useEffect(() => {
		flushWorkflowNotices()
	}, [subagents, flushWorkflowNotices])

	/**
	 * An accepted `send_message` correction already lands its own queue row inside
	 * the child's transcript (`SubagentActivityMonitor.recordMessage`); this
	 * mirrors it into the main conversation so the operator sees what was
	 * sent without drilling in. Deliberately a separate ref from
	 * `reportedAgentsRef` above: that gate is exactly-once per terminal
	 * agent, this one is one notice per accepted message, and folding the
	 * two together would let one gate's reset silently double-report the
	 * other's rows.
	 */
	const reportedCorrectionsRef = useRef(new Set<string>())
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => {
		reportedCorrectionsRef.current.clear()
	}, [session])
	useEffect(() => {
		const current = session?.subagents?.getSnapshot() ?? []
		for (const agent of subagents) {
			const live = current.find(
				(item) => item.viewId === agent.viewId && item.workflowId === agent.workflowId,
			)
			if (!live) continue
			for (const row of agent.transcript) {
				if (row.kind !== 'system' || row.direction !== 'to-child') continue
				if (!live.transcript.some((item) => item.id === row.id)) continue
				if (reportedCorrectionsRef.current.has(row.id)) continue
				reportedCorrectionsRef.current.add(row.id)
				pushMessage('tool', `${agent.description} · correction sent`, false, '→', [row.text])
			}
		}
	}, [subagents, pushMessage, session])

	/**
	 * Change the permission mode, now — including while a turn runs.
	 *
	 * It used to be refused until the current work settled. Shift+Tab applies at once, mid-turn, and
	 * so does this: the running
	 * turn reads the mode at every decision (`SendOptions.currentPermissionMode`),
	 * so the change governs its next tool call and every turn after. A dialog
	 * already on screen is decided under the mode it was asked under; entering
	 * plan refuses the next change the turn attempts; leaving plan re-runs
	 * nothing it refused. The change is recorded on the running turn's log as
	 * `approval_policy_changed`, which also tells the model once.
	 *
	 * `announce` is for a change asked for by name (`/permissions`), which gets
	 * a reply. Shift+Tab is a reflex key: the footer is its reply, and five presses no longer leave
	 * five transcript lines.
	 */
	/** The two modes that stop asking, as Shift+Tab and the picker see them right now. */
	const permissionAvailability = useCallback(
		(): ModeAvailability => ({
			bypass: bypassAvailableRef.current,
			auto: autoModeAvailable({
				disabled: ctx.permissionSettings?.disableAutoMode === true,
				classifierUsable: session?.autoMode?.available ?? true,
			}),
		}),
		[ctx.permissionSettings, session],
	)

	const commitPermissionMode = useCallback(
		(mode: PermissionMode, announce: boolean): void => {
			if (!session?.hasProvider) return
			// The ref first: a running turn reads it at its next decision, and the
			// record below makes the change durable before that decision is made.
			permissionModeRef.current = mode
			permissionModeSourceRef.current = 'session'
			setPermissionModeState(mode)
			void session.setPermissionMode?.(mode)
			rulesChanged()
			if (announce) {
				pushMessage(
					'system',
					`Permissions: ${permissionModeLabel(mode)} for this conversation. ${permissionModeDescription(mode)}`,
				)
			} else if (mode === 'classify' && !autoModeNoticeShownRef.current) {
				// Shift+Tab is a reflex and its reply is the footer, but this mode
				// hands decisions to a second model, which is worth saying once.
				autoModeNoticeShownRef.current = true
				pushMessage(
					'system',
					'Auto mode: a second model checks each call you would be asked about.',
				)
			}
		},
		[pushMessage, rulesChanged, session],
	)

	const applyPermissionMode = useCallback(
		(mode: PermissionMode, announce = true): void => {
			if (!session?.hasProvider) {
				pushMessage('system', 'Choose a model before changing permissions.')
				return
			}
			if (mode === 'bypass' && permissionModeRef.current !== 'bypass') {
				// Opening this door is the launch's decision: a flag that names it, or
				// the operator's own default. Nothing typed here opens it.
				if (!bypassAvailableRef.current) {
					pushMessage('system', BYPASS_UNAVAILABLE_NOTICE)
					return
				}
				// Asked once per person, and only here, where it is about to start.
				if (!hasAcknowledgedBypass()) {
					if (permissionResolveRef.current !== null) {
						pushMessage('system', 'Answer the question on screen before switching to bypass.')
						return
					}
					setChoicePicker(bypassConsentPicker(announce))
					return
				}
			}
			if (mode === 'classify' && permissionModeRef.current !== 'classify') {
				if (
					!autoModeAvailable({
						disabled: ctx.permissionSettings?.disableAutoMode === true,
						classifierUsable: session.autoMode?.available ?? true,
					})
				) {
					pushMessage('system', session.autoMode?.reason ?? AUTO_UNAVAILABLE_NOTICE)
					return
				}
			}
			commitPermissionMode(mode, announce)
		},
		[commitPermissionMode, ctx.permissionSettings, pushMessage, session, setChoicePicker],
	)

	/**
	 * The classifier has blocked too many calls to be relied on. The kernel
	 * leaves the mode alone; this is the half that changes it, quietly: back to
	 * asking, with the reason in the transcript, and the footer follows.
	 */
	const handleAutoModeLimit = useCallback(
		(event: {
			readonly limit: 'consecutive' | 'total'
			readonly reason: string
		}): void => {
			if (permissionModeRef.current !== 'classify') return
			commitPermissionMode('prompt', false)
			pushMessage(
				'system',
				`${event.limit === 'consecutive' ? 'Auto mode blocked three actions in a row' : 'Auto mode has blocked twenty actions in this conversation'}, so Namzu will ask before changes again. ${event.reason}`,
			)
		},
		[commitPermissionMode, pushMessage],
	)

	const applyReasoningEffort = useCallback(
		(effort: ReasoningEffort | undefined, selectedSession?: AgentSession): void => {
			if (!session?.hasProvider) {
				pushMessage(
					'system',
					'No model is connected yet — pick a provider with /model before changing reasoning effort.',
				)
				return
			}
			if (selectedSession !== undefined && selectedSession !== session) {
				pushMessage(
					'system',
					'Reasoning effort was not changed: the selected model is no longer active.',
				)
				return
			}
			if (
				state !== 'idle' ||
				abortRef.current !== null ||
				hasUnsettledTurn() ||
				(queuedRef.current.length > 0 && selectedSession !== session) ||
				permissionResolveRef.current !== null ||
				compactingRef.current
			) {
				pushMessage(
					'system',
					'Reasoning effort was not changed: wait for the current reply and queued messages to finish.',
				)
				return
			}
			if (effort === undefined) {
				setReasoningEffort(undefined)
				pushMessage('system', 'Reasoning: provider default.')
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
			pushMessage('system', `Reasoning: ${effort} (this conversation).`)
		},
		[hasUnsettledTurn, pushMessage, session, setReasoningEffort, state],
	)

	/**
	 * Turn the session's hypermode on or off.
	 *
	 * An independent switch: it never changes the reasoning effort, and the
	 * message says so ("Effort stays X"). While it is on, `SendOptions.hypermode`
	 * tells the model, in request-only context, to use the `workflow` tool for
	 * substantial work (see `hypermodeReminders`). See `applyReasoningEffort`
	 * above for the mirrored guard shape.
	 */
	const applyHypermode = useCallback(
		(enabled: boolean, selectedSession?: AgentSession): void => {
			if (!session?.hasProvider) {
				pushMessage(
					'system',
					'No model is connected yet — pick a provider with /model before turning hypermode on.',
				)
				return
			}
			if (selectedSession !== undefined && selectedSession !== session) {
				pushMessage('system', 'Hypermode was not changed: the selected model is no longer active.')
				return
			}
			if (
				state !== 'idle' ||
				abortRef.current !== null ||
				hasUnsettledTurn() ||
				(queuedRef.current.length > 0 && selectedSession !== session) ||
				permissionResolveRef.current !== null ||
				compactingRef.current
			) {
				pushMessage(
					'system',
					'Hypermode was not changed: wait for the current reply and queued messages to finish.',
				)
				return
			}
			if (!enabled && !hypermodeRef.current) {
				pushMessage('system', 'Hypermode is off.')
				return
			}
			const newlyEnabled = enabled && !hypermodeRef.current
			setHypermode(enabled)
			if (newlyEnabled) setHypermodeActivation((activation) => activation + 1)
			const effort = reasoningEffortRef.current
			const hasLevels = (session.reasoningEffortLevels?.length ?? 0) > 0
			pushMessage(
				'system',
				enabled ? hypermodeOnMessage(effort, hasLevels) : hypermodeOffMessage(effort, hasLevels),
			)
		},
		[hasUnsettledTurn, pushMessage, session, setHypermode, state],
	)

	const stepReasoningEffort = useCallback(
		(direction: 'lower' | 'raise'): void => {
			const levels = session?.reasoningEffortLevels
			if (!session?.hasProvider || levels === undefined || levels.length === 0) {
				pushMessage(
					'system',
					'Reasoning shortcuts are unavailable because the current provider chain has no exact non-empty effort menu.',
				)
				return
			}
			const selected = reasoningEffortRef.current
			const anchor =
				selected !== undefined && levels.includes(selected)
					? selected
					: session.reasoningEffortDefault
			if (anchor === undefined || !levels.includes(anchor)) {
				pushMessage(
					'system',
					'Reasoning shortcuts are unavailable because the provider chain does not publish one exact default. Use /effort to choose a level explicitly.',
				)
				return
			}
			const index = levels.indexOf(anchor)
			const next = direction === 'raise' ? levels[index + 1] : levels[index - 1]
			if (next === undefined) {
				pushMessage(
					'system',
					`Reasoning is already at the ${direction === 'raise' ? 'highest' : 'lowest'} shortcut level (${anchor}).`,
				)
				return
			}
			if (direction === 'raise' && (next === 'max' || next === 'ultra')) {
				pushMessage(
					'system',
					`${next} is an advanced reasoning level. Choose it explicitly with /effort.`,
				)
				return
			}
			applyReasoningEffort(next)
		},
		[applyReasoningEffort, pushMessage, session],
	)

	const recordFeedback = useCallback(
		(sessionId: SessionId, messageIdValue: string, rating: 'good' | 'bad', note?: string) => {
			const sessions = sessionsRef.current
			if (!sessions) {
				pushSystem('error', 'Could not record feedback: this conversation is not being saved.')
				return
			}
			// Feedback lives beside the conversation's log (`<session-id>/feedback/`)
			// and is checked against it: a rating names a message that log holds.
			// Bound to the exact conversation captured with the streamed message;
			// `/resume` may change the active scope before a delayed click.
			const store = new DiskMessageFeedbackStore({ paths: sessions.paths })
			const messageId = messageIdValue as MessageId
			void (async () => {
				try {
					// A later rating replaces the first. Read-then-write preserves the
					// store's owner-version collision check instead of blind overwrite.
					const current = (await store.listMessageFeedback({ sessionId })).find(
						(record) => record.messageId === messageId,
					)
					const record = await store.putMessageFeedback({
						sessionId,
						messageId,
						rating,
						...(note ? { note } : {}),
						expectedVersion: current?.ownerVersion ?? 0,
					})
					pushMessage('system', `Recorded ${record.rating} for ${record.messageId}.`)
				} catch (error) {
					pushSystem('error', explainFailure(error, 'Could not record feedback.'))
				}
			})()
		},
		[pushMessage, pushSystem],
	)

	const activateSkill = useCallback(
		(name: string): void => {
			const info = discoverSkills({
				cwd: ctx.cwd,
				...(ctx.skills ? { config: ctx.skills } : {}),
			}).find((skill) => skill.name === name)
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
				conversationLearning().skillUsed = true
				pushMessage('system', `Activated skill: ${info.name}`)
			} catch (error) {
				pushSystem('error', explainFailure(error, `Could not load skill "${name}".`))
			}
		},
		[conversationLearning, ctx.cwd, ctx.skills, pushMessage, pushSystem],
	)

	const removeStoredCredential = useCallback(
		(target: SubscriptionProviderId | 'google' | 'all'): void => {
			const path = target === 'google' ? googleApiKeyPath() : credentialsPath()
			const hadClaude = readStoredSubscriptionCredential() !== null
			const hadCodex = readStoredCodexCredential() !== null
			const hadGoogleKey = readStoredGoogleApiKey() !== null
			if (target === 'all') {
				const failures: string[] = []
				try {
					clearAllStoredCredentials()
				} catch (error) {
					failures.push(explainFailure(error, `${credentialsPath()}.`))
				}
				try {
					clearStoredGoogleApiKey()
				} catch (error) {
					failures.push(explainFailure(error, `${googleApiKeyPath()}.`))
				}
				if (failures.length > 0) {
					pushMessage(
						'system',
						`Some stored credentials could not be removed: ${failures.join('; ')}. Check both stores before retrying.`,
					)
					return
				}
				pushMessage(
					'system',
					describeAllCredentialsLogout(
						path,
						googleApiKeyPath(),
						hadClaude || hadCodex || hadGoogleKey,
					),
				)
				return
			}
			try {
				if (target === 'anthropic') clearStoredSubscriptionCredential()
				else if (target === 'codex') clearStoredCodexCredential()
				else clearStoredGoogleApiKey()
			} catch (error) {
				pushSystem('error', explainFailure(error, `Could not remove ${homePath(path)}.`))
				return
			}
			pushMessage(
				'system',
				describeProviderLogout(
					path,
					target,
					target === 'anthropic' ? hadClaude : target === 'codex' ? hadCodex : hadGoogleKey,
				),
			)
		},
		[pushMessage, pushSystem],
	)

	/** Publish one recoverable, read-only tombstone before leaving the TUI. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const archiveCurrentConversation = useCallback((): void => {
		if (conversationMutationRef.current) return
		const sessions = sessionsRef.current
		const sessionId = scopeRef.current?.sessionId
		if (!sessions || !sessionId || !conversationMaterializedRef.current) {
			pushMessage(
				'system',
				!conversationMaterializedRef.current
					? 'There is no conversation to archive yet — send a message first.'
					: 'Cannot archive this conversation because it is not being saved.',
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
				'A reply, queued message, summary or export is still running. Wait for it to finish, then archive.',
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
				closeAndExit()
			} catch (error) {
				pushMessage(
					'system',
					error instanceof ConversationIndexRefreshError
						? error.message
						: explainFailure(error, 'Could not archive this conversation.'),
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
		if (!sessions || !sessionId || !conversationMaterializedRef.current) {
			pushMessage(
				'system',
				!conversationMaterializedRef.current
					? 'There is no conversation to export yet — send a message first.'
					: 'Cannot export this conversation because it is not being saved.',
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
				'A reply, queued message, summary or export is still running. Wait for it to finish, then export.',
			)
			return null
		}
		return { sessions, sessionId }
	}, [hasUnsettledTurn, pushMessage, state])

	/**
	 * Shift+Tab: `prompt` → `accept-edits` → `plan` → `auto` → `prompt`. `auto` is a stop only when
	 * the session may use it
	 * (launched in it, or `--allow-dangerously-skip-permissions`); otherwise
	 * plan returns to `prompt`. `strict` is a deliberate choice made by name
	 * in `/permissions` and the key returns it to `prompt`. The change goes through the same path `/permissions`
	 * uses and takes effect at once, mid-turn included; the footer is its only
	 * on-screen reply (see `applyPermissionMode`).
	 */
	const cyclePermissionMode = useCallback((): void => {
		const current = permissionModeRef.current
		applyPermissionMode(nextCycleMode(current, permissionAvailability()), false)
	}, [applyPermissionMode, permissionAvailability])

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
						throw new Error('The active conversation changed before the export finished.')
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
							`Exported ${plural(projected.turns, 'reply', 'replies')} to ${homePath(written.path)} (${formatSize(written.bytes)}). Existing files are never overwritten.`,
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
								clipboardSentNotice(
									projected.markdown.length,
									plural(projected.turns, 'reply', 'replies'),
								),
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
								`Cannot send the verified export to the terminal clipboard — it is ${formatSize(result.bytes)} and the limit for the terminal clipboard is ${formatSize(result.limit)}. Nothing was truncated; choose Save to file instead.`,
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
						err instanceof Error && err.message.startsWith('Export target already exists')
							? 'That file already exists, so nothing was overwritten. Choose another name.'
							: explainFailure(err, 'Could not export this conversation.'),
					)
				} finally {
					exportingRef.current = false
					if (conversationGenRef.current === generation) setState('idle')
				}
			})()
		},
		[ctx.cwd, pushMessage, stableExportSource, stdout.isTTY, writeStdout],
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const applyChoiceSelection = useCallback(
		(index: number): void => {
			const picker = choicePickerRef.current
			if (!picker) return
			const value = picker.values[index]
			if (index < 0 || index >= picker.values.length) return
			if (picker.options[index]?.disabledReason) return
			if (picker.kind === 'plugin' || picker.kind === 'plugin-action') {
				if (picker.busy || picker.owner !== session) return
				if (picker.kind === 'plugin') {
					const child = pluginActionPicker(picker.owner, value as string)
					setSelectedChoice(0)
					setChoicePicker(child ? { ...child, back: picker } : null)
					return
				}
				const plugin = picker.owner.plugins?.list().find((item) => item.name === picker.pluginName)
				if (!plugin || !picker.owner.plugins) return
				if (value === 'details') {
					setChoicePicker(null)
					pushMessage('system', pluginDetails(plugin))
					return
				}
				if (state !== 'idle' || permission) {
					setChoicePicker({
						...picker,
						notice: 'Wait for the current reply and permission prompts to finish.',
					})
					return
				}
				const enabled = value === 'enable'
				const remembering = value === 'remember'
				const pending: ChoicePickerState = {
					...picker,
					busy: true,
					notice: remembering
						? 'Saving plugin setting…'
						: enabled
							? 'Enabling plugin…'
							: 'Disabling plugin…',
				}
				setChoicePicker(pending)
				const generation = conversationGenRef.current
				const change = remembering
					? picker.owner.plugins.rememberState(plugin.name)
					: picker.owner.plugins.setEnabled(plugin.name, enabled)
				void change.then(
					() => {
						if (
							appLifetime.signal.aborted ||
							conversationGenRef.current !== generation ||
							choicePickerRef.current !== pending
						)
							return
						const updated = pluginActionPicker(picker.owner, plugin.name)
						setSelectedChoice(0)
						setChoicePicker(updated ? { ...updated, back: loadedPluginPicker(picker.owner) } : null)
					},
					(error: unknown) => {
						if (
							appLifetime.signal.aborted ||
							conversationGenRef.current !== generation ||
							choicePickerRef.current !== pending
						)
							return
						const updated = pluginActionPicker(picker.owner, plugin.name)
						setChoicePicker(
							updated
								? {
										...updated,
										back: loadedPluginPicker(picker.owner),
										notice: explainFailure(error, 'Could not change plugin.'),
									}
								: null,
						)
					},
				)
				return
			}
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
								back: picker,
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
								back: picker,
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
							pushSystem('error', `Could not resolve a merge base for ${branch}.`)
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
			if (picker.kind === 'user-question') {
				const pending = questionRef.current
				setChoicePicker(null)
				if (!pending) return
				if (value === FREE_TEXT_ANSWER) {
					// The scope on a text prompt is what its other kinds check
					// against a conversation switch; a question belongs to the turn
					// that asked it, and the turn holds the promise.
					const scope = scopeRef.current
					if (!scope) {
						resolveQuestion({ kind: 'skip' })
						return
					}
					textPromptTokenRef.current += 1
					setTextPrompt({
						token: textPromptTokenRef.current,
						kind: 'user-question',
						title: pending.question.question,
						placeholder: 'Type your answer and press Enter · Esc skips',
						emptyNotice: 'An empty answer is a skip. Press Esc to skip.',
						initialValue: '',
						sessionId: scope.sessionId,
					})
					return
				}
				// The tool's own result row carries the answer the model saw; this
				// row is the operator's, so a reader of the transcript sees the
				// question and the choice together where it happened.
				pushMessage(
					'system',
					`Answered "${pending.question.question}": ${labelOfOption(pending.question, value as string)}`,
					false,
					'?',
				)
				resolveQuestion({
					kind: 'answer',
					selectedOptionIds: [value as string],
				})
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
			if (picker.kind === 'resume-goal') {
				if (value === 'resume' && scopeRef.current?.sessionId === picker.sessionId)
					commandPickerSubmitRef.current('/goal resume')
				return
			}
			if (picker.kind === 'command') {
				const command = value as CommandPickerEntry
				if (command.problem) {
					pushMessage('system', `Cannot run /${command.name}: ${command.problem}`)
					return
				}
				commandPickerSubmitRef.current(`/${command.name}`)
				const child = choicePickerRef.current
				if (child) setChoicePicker({ ...child, back: picker })
				return
			}
			if (picker.kind === 'agent-batches') {
				if (value === 'loading') return
				void openBatch(value as Batch)
				return
			}
			if (picker.kind === 'workflow-runs') {
				const run = workflowRunsRef.current.find((item) => item.runId === value)
				if (run && !openWorkflowFromRail(run.groupId)) {
					pushMessage('system', 'That workflow has nothing to show yet.')
				}
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
					pushMessage('system', 'Cannot export this conversation because it is not being saved.')
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
			if (picker.kind === 'bypass-consent') {
				if (value === 'accept') {
					try {
						acknowledgeBypass()
					} catch {
						// An unwritable home costs a repeat of the question next time.
					}
					commitPermissionMode('bypass', picker.announce)
				}
				return
			}
			if (picker.kind === 'permission-mode') {
				if (value === 'more') {
					const child = permissionPicker(permissionModeRef.current, true, permissionAvailability())
					setSelectedChoice(
						Math.max(
							0,
							child.options.findIndex((option) => option.current),
						),
					)
					setChoicePicker({ ...child, back: picker })
					return
				}
				if (value === 'rules') {
					commandPickerSubmitRef.current('/permissions details')
					return
				}
				applyPermissionMode(value as PermissionMode)
				return
			}
			if (picker.kind === 'agent-view-command') {
				if (value !== 'run') return
				// The draft held the line while the question was open; the command
				// takes it now.
				composerDraftTokenRef.current += 1
				setComposerDraft({ token: composerDraftTokenRef.current, text: '' })
				mainCommandConfirmedRef.current = picker.line
				commandPickerSubmitRef.current(picker.line)
				return
			}
			if (picker.kind === 'theme') {
				applyThemeChoice(value as ThemeSetting)
				return
			}
			if (picker.kind === 'feedback-rating') {
				recordFeedback(picker.sessionId, picker.messageId, value as 'good' | 'bad')
				return
			}
			if (picker.kind === 'skill') {
				activateSkill(value as string)
				return
			}
			if (picker.kind === 'credential-logout') {
				removeStoredCredential(value as SubscriptionProviderId | 'google')
				return
			}
			if (picker.kind === 'reasoning-effort' && value === HYPERMODE_VALUE) {
				applyHypermode(!hypermodeRef.current, picker.selectedSession)
				return
			}
			applyReasoningEffort(value as ReasoningEffort | undefined, picker.selectedSession)
		},
		[
			activateSkill,
			advanceQueueContinuation,
			appLifetime.signal,
			applyHypermode,
			applyPermissionMode,
			applyReasoningEffort,
			archiveCurrentConversation,
			ctx.cwd,
			enqueueQueued,
			openBatch,
			pushMessage,
			recordFeedback,
			removeStoredCredential,
			runConversationExport,
			setChoicePicker,
			setSelectedChoice,
			setTextPrompt,
			session,
			state,
			permission,
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
					? 'the latest saved reply'
					: 'the latest normally completed answer'
			const selection = target.kind === 'whole' ? origin : `${target.label} from ${origin}`
			switch (result.kind) {
				case 'request-sent':
					pushMessage('system', clipboardSentNotice(target.text.length, selection))
					break
				case 'unavailable':
					pushMessage(
						'system',
						`Couldn’t copy here: ${result.detail}. /copy needs a terminal that allows clipboard access.`,
					)
					break
				case 'too-large':
					pushMessage(
						'system',
						`Cannot send this selection to the terminal clipboard — it is ${formatSize(result.bytes)} and the limit for the terminal clipboard is ${formatSize(result.limit)}. Nothing was truncated.`,
					)
					break
				case 'write-failed':
					pushSystem('error', `Could not send the terminal copy request: ${result.detail}`)
					break
				default: {
					const exhaustive: never = result
					void exhaustive
				}
			}
		},
		[pushMessage, setCopyPicker, stdout.isTTY, writeStdout, pushSystem],
	)

	const sendTerminalNotification = useCallback(
		(notification: TerminalNotification) => {
			// The hooks hear about every moment the operator's attention is wanted,
			// whether or not a terminal notification is configured: a script may be
			// the only thing that reaches them.
			if (notification.kind === 'approval-required') {
				session?.notifyHooks?.({
					type: 'approval_required',
					message: 'A tool call is waiting for approval.',
				})
			} else if (notification.kind === 'idle-prompt') {
				session?.notifyHooks?.({
					type: 'idle_prompt',
					message: 'Namzu is waiting for your input.',
				})
			} else {
				session?.notifyHooks?.({
					type: 'turn_settled',
					message:
						notification.outcome === 'completed'
							? 'The turn completed.'
							: notification.outcome === 'stopped'
								? 'The turn stopped and needs attention.'
								: 'The turn failed.',
				})
			}
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
		[ctx.tui, pushMessage, session, stdout.isTTY, writeStdout],
	)

	// The approval notice (terminal and hooks) is held back: it goes out only
	// when a dialog has been open for 6 s with no keypress, and not at all if
	// it was answered first. `ApprovalNotifier` owns the rule.
	const pauseClockRef = useRef(new PauseClock())
	const approvalSendRef = useRef(sendTerminalNotification)
	approvalSendRef.current = sendTerminalNotification
	const approvalNotifierRef = useRef<ApprovalNotifier | null>(null)
	if (approvalNotifierRef.current === null) {
		approvalNotifierRef.current = new ApprovalNotifier({
			now: Date.now,
			setTimer: (run, ms) => {
				const handle = setTimeout(run, ms)
				handle.unref?.()
				return handle
			},
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			lastInteractionAt: () => lastKeyAtRef.current,
			isDialogOpen: () =>
				permissionResolveRef.current !== null ||
				questionDialogRef.current !== null ||
				choicePickerRef.current !== null ||
				planPromptRef.current !== null ||
				scheduleReviewPromptRef.current !== null ||
				saveSkillPromptRef.current !== null,
			send: () => approvalSendRef.current({ kind: 'approval-required' }),
		})
	}
	const announceApproval = useCallback(() => approvalNotifierRef.current?.dialogOpened(), [])
	useEffect(() => () => approvalNotifierRef.current?.dispose(), [])

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
			if (st.releaseTimer) {
				clearTimeout(st.releaseTimer)
				st.releaseTimer = undefined
			}
			if (!st.pending || st.pending.length === 0) return
			const id = st.assistantId ?? pushMessage('assistant', '', true)
			st.assistantId = id
			appendToMessage(id, st.pending)
			st.pending = ''
			st.releasedAt = Date.now()
		},
		[appendToMessage, pushMessage],
	)

	/**
	 * Release held text to its last safe cut — a sentence or a line — when it
	 * has waited longer than `STREAM_RELEASE_MS`. Called from the delta path
	 * with the clock, and from the timer the delta path arms so a stream that
	 * goes quiet mid-paragraph still shows what it has.
	 */
	const releaseStalled = useCallback(
		(st: StreamState) => {
			if (!st.pending || st.pending.length === 0) return
			const { ready, rest } = splitSafeCut(st.pending)
			if (ready.length === 0) return
			const id = st.assistantId ?? pushMessage('assistant', '', true)
			st.assistantId = id
			st.pending = rest
			appendToMessage(id, ready)
			st.releasedAt = Date.now()
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

	/**
	 * Close the reply the running turn streamed before a tool took over, as a
	 * tool's start does. For a tool that shows the operator something of its
	 * own while it runs: the reply is complete by then (tools run after the
	 * model's response ends), and left pending it holds every later row out
	 * of scrollback. Text that arrives later starts a new reply.
	 */
	const closeLiveReply = useCallback(() => {
		const st = liveStreamRef.current
		if (!st) return
		flushStream(st)
		if (st.assistantId) {
			finalizeMessage(st.assistantId)
			st.assistantId = null
		}
	}, [finalizeMessage, flushStream])

	// Open the SDK session store and select the durable conversation once.
	// This is an admission gate for every startup, not optional persistence: a
	// corrupt or split estate must not silently widen into cwd-local state and
	// let the model run against a different history than the operator selected.
	const ensureSessions = useCallback(async (): Promise<SessionScope> => {
		if (scopeRef.current) return scopeRef.current
		const requestedConversationId = initialConversationIdRef.current
		const owner = tuiPalOwner(ctxRef.current.cwd, ctxRef.current.palId)
		const sessions = await openSessions(ctxRef.current.cwd)
		let sessionId: SessionId
		if (requestedConversationId) {
			palDefinitionRef.current = await tuiPalDefinition(
				ctxRef.current.cwd,
				requestedConversationId,
				ctxRef.current.palId,
			)
			const restored = await loadResumableConversation(sessions, requestedConversationId)
			sessionId = asSessionId(requestedConversationId)
			modelHistoryRef.current = restored
			// The same closing row every resume path draws: the title a person gave
			// it, else the first thing they typed.
			let named: string | undefined
			try {
				named = await titleOf(sessions, asSessionId(requestedConversationId))
			} catch {
				// A title is a courtesy; the conversation opens without it.
			}
			const resumedTitle = named ?? firstTypedPrompt(restored)
			setMessages([
				...projectConversation(restored, nextId, [], {
					trail: trailFromRecords(journalOf(restored)),
					cwd: ctxRef.current.cwd,
				}),
				...(resumedTitle
					? [
							{
								id: nextId(),
								role: 'system' as const,
								content: `Resumed: ${displayConversationTitle(resumedTitle)}`,
								glyph: systemRowStyle('notice').glyph,
								glyphColor: systemRowStyle('notice').color,
							},
						]
					: []),
			])
			setHistory(promptHistoryFromConversation(restored))
			const persistedOutput = latestAssistantOutput(restored)
			lastCompletedOutputRef.current = persistedOutput
				? { text: persistedOutput, provenance: 'persisted' }
				: null
			pendingGoalResumeRef.current = requestedConversationId
			pendingScheduledResumeRef.current = requestedConversationId
			initialConversationIdRef.current = undefined
			conversationMaterializedRef.current = true
		} else {
			// Provider/tool startup needs stable project/tenant/topic ids, not a
			// durable conversation. The cursor is replaced on first admitted use.
			// The conversation's id, chosen now; the conversation is written
			// under it at first durable use. Nothing that saw this id before
			// that moment — a hook, a log line, the screen — is later wrong.
			sessionId = generateSessionId()
			if (owner) {
				await claimPalConversation(owner.workspace, owner.id, sessionId)
				palDefinitionRef.current = await tuiPalDefinition(owner.workspace, sessionId, owner.id)
				conversationMaterializedRef.current = true
			}
		}
		sessionsRef.current = sessions
		scopeRef.current = {
			sessionId,
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		}
		if (conversationMaterializedRef.current) sourceDeliveryPollRef.current()
		return scopeRef.current
	}, [nextId])

	/** Publish the provisional conversation exactly once, at first durable use. */
	const materializeConversation = useCallback(async (): Promise<SessionScope | undefined> => {
		const existing = await ensureSessions()
		if (!existing) return undefined
		if (conversationMaterializedRef.current) return existing
		if (materializationRef.current) return materializationRef.current

		const pending = (async (): Promise<SessionScope | undefined> => {
			const sessions = sessionsRef.current
			const scope = scopeRef.current
			if (!sessions || !scope) return undefined
			conversationMutationRef.current = 'materialize'
			try {
				const written = await startConversation(sessions, scope.sessionId)
				if (scopeRef.current !== scope || conversationMaterializedRef.current) {
					throw new Error('the active conversation changed while its first session was published')
				}
				// The store creates the conversation under the id chosen at open,
				// so this is the same id; a store that cannot honour a chosen id
				// is followed rather than contradicted.
				if (written !== scope.sessionId) scope.sessionId = written
				conversationMaterializedRef.current = true
				sourceDeliveryPollRef.current()
				return scope
			} finally {
				if (conversationMutationRef.current === 'materialize') {
					conversationMutationRef.current = null
				}
			}
		})()
		materializationRef.current = pending
		try {
			return await pending
		} finally {
			if (materializationRef.current === pending) materializationRef.current = null
		}
	}, [ensureSessions])

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const hydrateSession = useCallback(
		async (
			requestedPrefs: Preferences,
			detectedNow: readonly DetectedProvider[],
			options: {
				readonly signal?: AbortSignal
				readonly persistSelection?: boolean
				readonly announce?: boolean
				/** Follow an interactive model choice with the published session's effort menu. */
				readonly chooseReasoningEffort?: boolean
				/** Revalidate a deferred host action immediately before candidate publication. */
				readonly beforePublish?: () => void
				/**
				 * Whether Auto runs on the rebuilt session. A model the person picked
				 * by hand passes `false`; choosing Auto passes `true`. Left out, a
				 * saved pick (`persistSelection`) turns it off and anything else
				 * keeps it as it is.
				 */
				readonly auto?: boolean
			} = {},
		) => {
			const { signal, persistSelection = false, announce = false } = options
			if (signal?.aborted) return
			const autoOn =
				ctxRef.current.routing !== undefined &&
				(options.auto ?? (persistSelection ? false : autoActiveRef.current))
			const scope = await ensureSessions()
			if (signal?.aborted) return
			const activeCtx = ctxRef.current
			const definition = await tuiPalDefinition(activeCtx.cwd, scope.sessionId, activeCtx.palId)
			const palEnvironment = definition
				? await tuiPalEnvironment(definition, scope.sessionId, signal)
				: undefined
			const prefs =
				definition && palRouteSessionRef.current !== scope.sessionId
					? (tuiPalPreferences(definition, palDefaultPreferencesRef.current ?? requestedPrefs) ??
						requestedPrefs)
					: requestedPrefs
			const primary = prefs.providers[0]
			if (primary && scheduleLiveRef.current) {
				scheduleLiveRef.current.model = {
					provider: primary.id,
					...(primary.model ? { model: primary.model } : {}),
				}
			}
			const browserConfig = activeCtx.browser
			const browserProfile = browserProfileRef.current ?? browserConfig?.defaultProfile
			const browserOptions = browserConfig
				? {
						...(browserProfile ? { profile: browserProfile } : {}),
						...(browserConfig.engine ? { engine: browserConfig.engine } : {}),
						...(browserConfig.headless ? { headless: browserConfig.headless } : {}),
						...(browserConfig.sites ? { sites: browserConfig.sites } : {}),
						...(browserConfig.keepOpen ? { keepOpen: true } : {}),
						...(sessionsRef.current ? { home: sessionsRef.current.root } : {}),
					}
				: undefined
			const s = await createAgentSession(prefs, detectedNow, {
				scope,
				cwd: activeCtx.cwd,
				// The composer opens on the saved or automatic model. The effort menu
				// waits for the provider's model listing, not the person.
				deferEffortCatalogue: true,
				...(palEnvironment
					? {
							palEnvironment,
							rules: activeCtx.rules,
							conversationSessions: sessionsRef.current!,
							...(activeCtx.limits ? { limits: activeCtx.limits } : {}),
						}
					: {
							// A person is here to confirm: the model may propose scheduled jobs
							// and session loops (never in exec, a scheduled run or a sub-agent).
							extraTools: [
								...peerTools,
								...(scheduleRef.current?.tools() ?? []),
								...(saveSkillToolRef.current ? [saveSkillToolRef.current] : []),
							],
							...(activeCtx.structuredOutput
								? { structuredOutput: activeCtx.structuredOutput }
								: {}),
							...(activeCtx.additionalDirectories
								? { additionalDirectories: activeCtx.additionalDirectories }
								: {}),
							...(sessionsRef.current ? { stateRoot: sessionsRef.current.root } : {}),
							enableComputerUse: true,
							// The browser tools, when the config did not switch them off. The
							// profile is the one `/browser profile` chose, else the config's.
							...(browserOptions ? { browser: browserOptions } : {}),
							// The code index tool: on unless the config switched it off.
							...(activeCtx.codeAnalysis?.enabled === false
								? {}
								: { codeAnalysis: activeCtx.codeAnalysis ?? {} }),
							rules: activeCtx.rules,
							...(sessionsRef.current
								? {
										sessionGoals: sessionsRef.current.goals,
										conversationSessions: sessionsRef.current,
									}
								: {}),
							...(activeCtx.mcpServers ? { mcpServers: activeCtx.mcpServers } : {}),
							...(activeCtx.plugins ? { plugins: activeCtx.plugins } : {}),
							...(activeCtx.skills ? { skills: activeCtx.skills } : {}),
							...(activeCtx.web ? { web: activeCtx.web } : {}),
							...(activeCtx.smallModel ? { smallModel: activeCtx.smallModel } : {}),
							...(activeCtx.hooks ? { hooks: activeCtx.hooks } : {}),
							...(activeCtx.compaction ? { compaction: activeCtx.compaction } : {}),
							...(activeCtx.memory ? { memory: activeCtx.memory } : {}),
							...(activeCtx.workflow ? { workflow: activeCtx.workflow } : {}),
							...(activeCtx.limits ? { limits: activeCtx.limits } : {}),
							...(activeCtx.sandbox ? { sandbox: activeCtx.sandbox } : {}),
							...(activeCtx.decision ? { decision: activeCtx.decision } : {}),
							...(activeCtx.routing && autoOn ? { routing: activeCtx.routing } : {}),
							// The operator's screens, on the same terms as every other
							// config field the App forwards. `!== undefined` rather than a
							// length test: `[]` is the off switch, and dropping it here
							// would leave the kernel's default in force in the interactive
							// session — always on, for the one operator who said otherwise.
							...(activeCtx.toolResultScreens !== undefined
								? { toolResultScreens: activeCtx.toolResultScreens }
								: {}),
							// Somebody is at this terminal, so the model may ask them one
							// question when a decision is genuinely theirs.
							askUser: true,
							// Plan mode gets its plan file and approval box, and each turn
							// the hidden reminders (plan mode's, the task-list nudge).
							planApproval: true,
							reminders: true,
							allowModelSwitch: true,
							// The user is at this desktop, so the model may open a page for them.
							openUrl: true,
						}),
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
				throw new StartupRefusal(reason)
			}
			let commands: ReturnType<typeof discoverUserCommands>
			try {
				options.beforePublish?.()
				commands = definition
					? []
					: discoverUserCommands({
							cwd: activeCtx.cwd,
							reserved: hostCommandNames(),
						})
				// Construction and validation precede the saved change. There is no
				// await between this atomic write and publishing the usable session.
				if (persistSelection && !definition) writePreferences(prefs)
			} catch (error) {
				try {
					await s.close()
				} catch {
					// Preserve the admission/save error and the still-active old session.
				}
				throw error
			}
			const previousPalDefinition = palDefinitionRef.current
			autoActiveRef.current = autoOn
			setAutoActive(autoOn)
			savedPrefsRef.current = prefs
			palDefinitionRef.current = definition
			palRouteSessionRef.current = definition ? scope.sessionId : null
			// The claimed Pal owns its guest. Only a default follows this route;
			// an operator's /permissions or Shift+Tab choice remains authoritative.
			if (permissionModeSourceRef.current === 'default') {
				const mode = definition ? 'auto' : 'prompt'
				permissionModeRef.current = mode
				setPermissionModeState(mode)
			}
			// A picker-owned provider/model change is one state transition. Clear the
			// old model's effort selection before publishing the replacement session
			// or releasing any paused queue. Failed and superseded candidates returned
			// above, so they leave the current session selection untouched. Hypermode
			// does not depend on effort, so it survives the switch as it is, and the
			// new model starts at its own default effort.
			if (signal !== undefined) setReasoningEffort(undefined)
			// Re-hydration (a provider switch via /model) builds a second session;
			// without this the first one's tool-server child processes stay alive
			// for the rest of the TUI's life.
			const previousInstructionFiles = previousSessionRef.current?.instructionFiles
			void previousSessionRef.current?.close()
			previousSessionRef.current = s
			setSession(s)
			// What the effort menu decides once the levels are final: a launch
			// `--effort`, and the picker a model change asks for. Run at once when the
			// provider named its levels, else when its model listing has answered.
			const settleEffort = () => {
				const launchEffort = launchEffortPendingRef.current
				if (launchEffort && s.hasProvider) {
					launchEffortPendingRef.current = undefined
					if (s.reasoningEffortLevels?.includes(launchEffort)) setReasoningEffort(launchEffort)
					else
						pushMessage(
							'system',
							`--effort ${launchEffort} is not offered by ${primaryProvider(prefs).model ?? primaryProvider(prefs).id}; using the provider default.`,
						)
				}
				// Hypermode is independent of effort, so the picker a model change
				// asks for opens whether or not it is on.
				if (options.chooseReasoningEffort && s.reasoningEffortLevels?.length) {
					// Own input before publishing ready or releasing a paused queue. The
					// menu closes only after choosing an effort or keeping the new default.
					setSelectedChoice(0)
					setChoicePicker(reasoningEffortPicker(s, undefined, true) ?? null)
				}
			}
			if (s.reasoningSettled === undefined) settleEffort()
			else {
				// The session is usable now; the levels follow the provider's model
				// listing. A listing that fails costs the effort menu and nothing else.
				void s.reasoningSettled.then(({ notice }) => {
					if (appLifetime.signal.aborted || previousSessionRef.current !== s) return
					reasoningListedRef.current = s
					setReasoningVersion((version) => version + 1)
					if (notice) pushMessage('system', notice)
					settleEffort()
				})
			}
			setUserCommands(commands)
			const mentionLoadOwner = {}
			mentionLoadOwnerRef.current = mentionLoadOwner
			void (
				definition ? Promise.resolve([]) : listMentionableFiles(activeCtx.cwd, appLifetime.signal)
			).then((files) => {
				if (!appLifetime.signal.aborted && mentionLoadOwnerRef.current === mentionLoadOwner)
					setMentionCandidates(files)
			})
			if (examplePrompts)
				void frequentlyModifiedFile(activeCtx.cwd, appLifetime.signal).then((file) => {
					if (!appLifetime.signal.aborted) setExampleFile(file)
				})
			setCurrentProvider(primaryProvider(prefs).id)
			// Failed and superseded provider choices returned above. A usable
			// provider change can recover a failed turn's dependent queue, but a
			// paused turn still owns the conversation's durable active slot. Keep
			// that queue held until its checkpoint is resumed and settles.
			if (signal !== undefined && queuePauseRef.current?.outcome !== 'paused')
				advanceQueueContinuation()
			if (s.hasProvider) {
				setTranscriptOwned(true)
				setPhase('ready')
				if (
					definition &&
					(!previousInstructionFiles ||
						previousPalDefinition?.revision !== definition.revision ||
						announce)
				) {
					pushMessage(
						'system',
						`Pal: ${definition.name} · profile revision ${definition.revision} · own local computer`,
					)
				}
				// Startup identity already lives in the footer. Confirm an explicit
				// picker selection, but do not add a routine connection log to chat.
				if (announce) {
					pushMessage(
						'system',
						`Connected to ${s.providerSummary}${s.modelSummary ? ` · ${s.modelSummary}` : ''}`,
					)
				}
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
				if (
					s.instructionFiles.length > 0 &&
					JSON.stringify([...s.instructionFiles].sort()) !==
						JSON.stringify(
							previousInstructionFiles ? [...previousInstructionFiles].sort() : undefined,
						)
				) {
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
				if (s.errorHint) pushMessage('system', s.errorHint, false, STARTUP_STOP_GLYPH)
			}
		},
		[
			appLifetime.signal,
			advanceQueueContinuation,
			ensureSessions,
			pushMessage,
			setChoicePicker,
			setReasoningEffort,
			setSelectedChoice,
		],
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
					await runProbeRef.current?.({ announce: true })
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
						setPickerNotice(explainFailure(error, 'Could not start Codex sign-in.'))
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
					await runProbeRef.current?.({ signal, announce: true })
				}
				return 'finished'
			}
			let start: SubscriptionLogin
			try {
				start = await beginSubscriptionLogin({ signal })
			} catch (err) {
				if (signal.aborted) return 'failed'
				setPickerNotice(explainFailure(err, 'Could not start a sign-in.'))
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
				await runProbeRef.current?.({ signal, announce: true })
			}
			return 'finished'
		},
		[],
	)

	const runProbe = useCallback(
		async (
			options: {
				readonly signal?: AbortSignal
				readonly announce?: boolean
			} = {},
		) => {
			const { signal, announce = false } = options
			try {
				if (signal?.aborted) return
				// An exact shell resume owns conversation admission before provider
				// discovery or construction. A malformed/missing id must not consume
				// model work and then quietly continue in a fresh conversation.
				if (
					initialConversationIdRef.current ||
					ctxRef.current.palId ||
					tuiPalOwner(ctxRef.current.cwd)
				) {
					try {
						await ensureSessions()
					} catch (error) {
						setPhase('unhealthy')
						pushMessage(
							'system',
							explainFailure(
								error,
								initialConversationIdRef.current
									? 'Could not resume that conversation.'
									: 'Could not open this Pal.',
							),
							false,
							STARTUP_STOP_GLYPH,
						)
						return
					}
				}
				const probe = await probeAgentSession()
				if (signal?.aborted) return
				setDetected(probe.detected)
				palDefaultPreferencesRef.current = probe.preferences
				const pinnedPal = palDefinitionRef.current
				if (pinnedPal?.model) {
					const preferences = tuiPalPreferences(pinnedPal, probe.preferences)
					if (!preferences) throw new Error('The Pal has no available model route.')
					await hydrateSession(preferences, probe.detected, {
						signal,
						announce,
					})
					return
				}
				const launch = ctxRef.current.launchSettings
				if (launch && launchModelPendingRef.current) {
					launchModelPendingRef.current = false
					const requested = launchPreferences(probe.preferences, launch)
					const admissionSignal = signal ?? appLifetime.signal
					const toPicker = (notice: string) => {
						setPickerDetected(null)
						setPickerSelectionKind('provider-and-model')
						setPickerInitialView('providers')
						pushMessage('system', notice)
						setPickerNotice(notice)
						setPhase('picker')
					}
					if (!requested) {
						toPicker('--model needs --provider here: no provider is saved to apply it to.')
						return
					}
					const askedFor = requested.providers[0]?.id
					if (launch.provider && askedFor && !Object.hasOwn(PROVIDER_REGISTRY, askedFor)) {
						toPicker(
							`${launch.provider} is not a provider Namzu knows. Choose one from the list below.`,
						)
						return
					}
					try {
						// Never persisted: the launch flags choose this session only.
						await hydrateSession(requested, probe.detected, {
							signal: admissionSignal,
							announce,
						})
						// A model name the provider does not list would only fail on the
						// first message, so say so now. Never blocks the launch.
						const askedModel = launch.model
						const listed = probe.detected.find((item) => item.entry.id === askedFor)
						if (askedModel && listed) {
							void describeProviderModels(listed.entry.id, listed, admissionSignal)
								.then((listing) => {
									if (listing.kind === 'ok' && !listing.models.some((m) => m.id === askedModel)) {
										pushMessage(
											'system',
											`${productName(listed.entry.id) ?? 'The provider'} has no model called ${askedModel}. Replies will fail until you pick another with /model.`,
										)
									}
								})
								.catch(() => undefined)
						}
					} catch (error) {
						if (admissionSignal.aborted) return
						toPicker(
							explainFailure(
								error,
								`Could not start with ${productName(launch.provider ?? requested.providers[0]?.id) ?? 'that provider'}${launch.model ? ` and ${launch.model}` : ''}.`,
							),
						)
					}
					return
				}
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
					await hydrateSession(probe.preferences, probe.detected, {
						signal,
						announce,
					})
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
						await hydrateSession(automaticPreferences, probe.detected, {
							signal: admissionSignal,
							announce,
						})
						if (!admissionSignal.aborted)
							pushMessage(
								'system',
								describeAutomaticChoice({
									provider: chosen,
									kind: automaticKind(chosen),
								}),
							)
						return
					} catch (error) {
						if (admissionSignal.aborted) return
						setPickerDetected(null)
						setPickerSelectionKind('provider-and-model')
						setPickerInitialView('providers')
						setPickerNotice(
							explainFailure(error, `Couldn’t start with your ${chosen.entry.label} sign-in.`),
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
						'Several sign-ins are already on this computer. Choose which one Namzu should use.',
					)
					setPhase('picker')
					return
				}
				// No sign-in to prefer: start with what else this computer offers (a key, a local
				// server, then the free Zen models) so a first open works with nothing to set up.
				// Nothing is saved; /model changes it, and a later key or sign-in wins next time.
				const automatic = automaticChoice(probe.detected)
				if (automatic) {
					const admissionSignal = signal ?? appLifetime.signal
					try {
						await hydrateSession(
							{
								version: 3,
								providers: [{ id: automatic.provider.entry.id }],
								subagents: { active: [] },
							},
							probe.detected,
							{ signal: admissionSignal, announce },
						)
						if (!admissionSignal.aborted) pushMessage('system', describeAutomaticChoice(automatic))
						return
					} catch (error) {
						if (admissionSignal.aborted) return
						setPickerDetected(null)
						setPickerSelectionKind('provider-and-model')
						setPickerInitialView('providers')
						setPickerNotice(explainFailure(error, 'Couldn’t start with what Namzu found.'))
						setPhase('picker')
						return
					}
				}
				setPickerDetected(null)
				setPickerSelectionKind('provider-and-model')
				setPickerInitialView('providers')
				setPhase('picker')
			} catch (err) {
				if (signal?.aborted) return
				setPhase('unhealthy')
				setStartupExplained(err instanceof ConfigLoadError && err.complete)
				pushMessage(
					'system',
					// A startup refusal is Namzu's own repair instruction ("split histories … run
					// namzu state …"), so it is shown as written.
					err instanceof Error && err.message && !isMachineError(err)
						? err.message
						: explainFailure(err, 'Could not check which agents are available.'),
					false,
					STARTUP_STOP_GLYPH,
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
				setStartupExplained(err instanceof ConfigLoadError && err.complete)
				pushMessage('system', projectSettingsFailure(err), false, STARTUP_STOP_GLYPH)
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
			setStartupExplained(err instanceof ConfigLoadError && err.complete)
			pushMessage('system', projectSettingsFailure(err), false, STARTUP_STOP_GLYPH)
		}
	}, [activateTrustedProject, pushMessage, runProbe])

	const finalized = messages.filter((m) => !m.pending)
	const runningShellCount = backgroundJobs.filter(
		(job) => job.status === 'running' && job.kind !== 'monitor',
	).length
	const runningMonitorCount = backgroundJobs.filter(
		(job) => job.status === 'running' && job.kind === 'monitor',
	).length
	// One stop in the rail serves both: they open the same screen.
	shellCountRef.current = runningShellCount + runningMonitorCount
	// The footer's pull request item: looked up in the background, paused while
	// a turn runs, and only on a real terminal.
	const prStatus = usePrStatus({
		cwd: ctx.cwd,
		enabled: stdout.isTTY === true && phase !== 'trust',
		turnActive: state === 'thinking' || state === 'tool' || state === 'awaiting-permission',
	})
	// The operator's status line command (docs/cli/status-line.md). Runs only
	// on a real terminal and only past the trust screen, which is where a
	// project-defined command first becomes reachable.
	const statusLineStartedAt = useRef(Date.now())
	const statusLineText = useStatusLine({
		config: ctx.statusLine,
		enabled: stdout.isTTY === true && phase !== 'trust',
		cwd: ctx.cwd,
		columns: terminal.columns,
		read: () => ({
			sessionId: scopeRef.current?.sessionId,
			cwd: ctx.cwd,
			projectDir: trustedCwdRef.current,
			addedDirs: ctx.additionalDirectories ?? [],
			model: session?.modelSummary ?? null,
			version: ctx.version,
			permissionMode,
			...(reasoningEffort ? { effort: reasoningEffort } : {}),
			...(palDefinitionRef.current ? { agentName: palDefinitionRef.current.name } : {}),
			pr: prStatus,
			totalCostUsd: usage?.cost.totalCost ?? 0,
			sessionStartedAt: statusLineStartedAt.current,
			...(usage?.context
				? {
						context: {
							tokens: usage.context.tokens,
							windowTokens: usage.context.windowTokens,
						},
					}
				: {}),
		}),
		triggers: [
			usage?.totalTokens,
			usage?.context?.tokens,
			permissionMode,
			session?.modelSummary,
			reasoningEffort,
			prStatus.kind === 'pr' ? `${prStatus.number}:${prStatus.review}` : prStatus.kind,
			finalized.length,
		],
	})
	const pendingInputItems = pendingSteers.map((input) => ({
		text: input.prompt.recallText ?? input.prompt.text,
		attachmentCount: (input.prompt.attachments?.length ?? 0) + input.attachedFiles,
	}))
	const queuedInputItems = queued.map((prompt) => ({
		text:
			prompt.kind === 'goal'
				? 'Automatic goal continuation'
				: prompt.kind === 'notice'
					? 'Reporting what finished'
					: prompt.kind === 'peer'
						? peerMailLabel(prompt.mail)
						: (prompt.recallText ?? prompt.text),
		attachmentCount: prompt.kind === 'human' ? prompt.attachments?.length : undefined,
	}))
	const pendingInputVisible =
		phase === 'ready' &&
		agentSurface === null &&
		!transcriptScreen &&
		!scrollOpen &&
		jobSurface === null &&
		permission === null &&
		saveSkillPrompt === null &&
		planPrompt === null &&
		questionDialog === null &&
		scheduleReviewPrompt === null &&
		textPrompt === null &&
		choicePicker === null &&
		copyPicker === null
	const pendingInputFurniture = pendingInputVisible
		? pendingInputPanelRows({
				pendingSteers: pendingInputItems,
				queued: queuedInputItems,
				rows: terminal.rows,
				working: abortRef.current !== null,
				held: queuePause,
			})
		: 0
	// Where the streaming reply stands among the finalized rows: a row written
	// while it streams is drawn below it, as it will be once it has finished.
	const streamingAt = messages.findIndex((m) => m.pending)
	const pendingAt =
		streamingAt < 0
			? finalized.length
			: messages.slice(0, streamingAt).filter((m) => !m.pending).length
	// Activity and the plan share the terminal with the draft. Collapse the two
	// lists together only when their full previews would crowd the input area.
	const fullToolFurniture = activeTools.length === 0 ? 0 : Math.min(activeTools.length, 3) * 2 + 2
	// The current-step row stands in for a checklist that is out of view. While
	// the newest checklist block, everything printed after it and the live
	// furniture fit the screen, the block is on screen, and the row would only
	// say one of its lines again. Once later rows push the block's head off a
	// short screen, the row is what keeps the current step visible.
	const checklistShown = checklistInView({
		messages,
		rows: terminal.rows,
		columns: terminal.columns,
		furnitureRows: LIVE_FURNITURE_ROWS + fullToolFurniture + pendingInputFurniture,
		raw: rawOutput,
	})
	const liveTasks = checklistShown ? [] : tasks
	const fullTaskFurniture = taskListRows(liveTasks)
	// The plan's next task, drawn under the working row; never from a sub-agent's plan.
	const nextPlanned = nextTask(tasks)
	const compactWork =
		LIVE_FURNITURE_ROWS + fullTaskFurniture + fullToolFurniture + pendingInputFurniture >=
		terminal.rows
	const taskFurniture = fullTaskFurniture
	const toolFurniture = compactWork && fullToolFurniture > 0 ? 2 : fullToolFurniture
	// How much of the transcript is still redrawable. The rest belongs to native
	// terminal scrollback; the live tail stays deliberately small so an activity
	// tick never repaints the whole conversation.
	//
	// The scroll view hides itself under a permission request or a review screen, but
	// it also swallows the main input handler's keys while it is open, so it has to
	// close: otherwise the request on screen could not be answered.
	useEffect(() => {
		if (
			permission !== null ||
			saveSkillPrompt !== null ||
			planPrompt !== null ||
			questionDialog !== null ||
			scheduleReviewPrompt !== null
		)
			setScrollOpen(false)
	}, [permission, saveSkillPrompt, planPrompt, questionDialog, scheduleReviewPrompt])
	// A ref, and mutated during render, because the split has to be MONOTONIC:
	// a row that has been printed to scrollback can never come back, and `max`
	// is idempotent, so a repeated render reaches the same answer.
	const window = liveWindow({
		messages: finalized,
		rows: terminal.rows,
		columns: terminal.columns,
		furnitureRows: LIVE_FURNITURE_ROWS + taskFurniture + toolFurniture + pendingInputFurniture,
		settled: settledRef.current,
		raw: rawOutput,
	})
	// A child view is a redrawable overlay above the parent's native scrollback.
	// Freeze the parent's Static floor while it is open; otherwise a parent turn
	// settling in the background prints through the child screen. Returning
	// advances the floor once and emits those finalized rows exactly once.
	const nextSettled = settledBeforeStreaming(messages, window.settled, settledRef.current)
	if (
		agentSurface === null &&
		!transcriptScreen &&
		!scrollOpen &&
		jobSurface === null &&
		scheduleReviewPrompt === null
	)
		settledRef.current = nextSettled
	const renderedSettled =
		agentSurface === null &&
		!transcriptScreen &&
		!scrollOpen &&
		jobSurface === null &&
		scheduleReviewPrompt === null
			? nextSettled
			: settledRef.current

	// One merged vocabulary for the session: this host's own commands plus
	// whatever the kernel's registry reports. Built here so `/help`, the
	// autocomplete and the dispatcher all answer from the same list — three
	// places that used to read one hardcoded array and would otherwise
	// disagree the moment a capability added a command.
	const hostCommands = mergeHostCommands(kernelCommandDescriptors())

	const slashCtx: SlashContext = {
		cwd: ctx.cwd,
		jobs: () => session?.jobs?.() ?? [],
		hooks: () => session?.hooks,
		directories: () => session?.directories?.list() ?? [],
		compaction: session
			? {
					strategy: ctx.compaction?.strategy ?? 'salience',
					softTarget: 0.5,
					triggerThreshold: resolveTriggerThreshold(
						undefined,
						usage?.context?.windowTokens ?? 200_000,
					),
					...compactionTally,
				}
			: null,
		builtins: hostCommands,
		lastAssistantMessageId: () => lastAssistantMessage.current?.messageId ?? null,
		// Called when `/tools` renders, not read here — the same shape, and the
		// same reason, as `neverPrompted` below.
		availableTools: () => session?.toolNames() ?? [],
		// From the session, not re-resolved: resolving builds a provider, and a
		// second one would describe a different sandbox than the turn is using.
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
			neverPrompted: () => session?.promptExemptTools() ?? [],
		},
		instructionFiles: session?.instructionFiles ?? [],
		userCommands,
		configDebug: ctx.configDebug ?? null,
		webSearchSummary: session?.webSearchSummary,
		columns: terminal.columns,
		sessionId: scopeRef.current?.sessionId,
	}

	// `/resume`: open the picker with this folder's recent conversations.
	/**
	 * `/abandon`: close this conversation's paused or interrupted turn without
	 * resuming it (`turn_failed{ abandoned }`), so the next prompt can begin a
	 * turn. A turn running in this process is stopped with esc, not abandoned.
	 */
	const abandonActiveTurn = useCallback(
		async (reason: string): Promise<void> => {
			const sessions = sessionsRef.current
			const scope = scopeRef.current
			if (!sessions || !scope || !conversationMaterializedRef.current) {
				pushMessage('system', 'Nothing to stop: this conversation has no reply yet.')
				return
			}
			if (abortRef.current || state !== 'idle') {
				pushMessage(
					'system',
					'A reply is running here. Press Esc to stop it; /abandon closes a paused or interrupted one.',
				)
				return
			}
			try {
				const active = await activeConversationTurn(sessions, scope.sessionId)
				if (!active) {
					pushMessage('system', 'This conversation has no paused or interrupted reply to abandon.')
					return
				}
				if (!session?.abandonTurn) {
					pushMessage('system', 'This conversation cannot stop a paused reply.')
					return
				}
				await session.abandonTurn(active.turnId as TurnId, reason)
				pushMessage('system', PAUSED_TURN_LINES.abandoned)
			} catch (err) {
				pushSystem('error', explainFailure(err, 'Couldn’t stop the paused reply.'))
			}
		},
		[pushMessage, session, state, pushSystem],
	)

	/**
	 * `/resume` in a conversation whose turn is parked: continue that turn —
	 * the same turn id, from its checkpoint — rendering it like any turn.
	 * Returns false when there is no parked turn to continue.
	 */
	// `applyEvent` is declared further down; the resume path reads it at call time.
	const applyEventRef = useRef<((event: AgentEvent, st: StreamState) => void) | null>(null)
	const resumeActiveTurn = useCallback(
		async (resume?: {
			/** Continuing a turn a tool paused for a person: what the tool asked for. */
			readonly handoffReason?: string | undefined
		}): Promise<boolean> => {
			const sessions = sessionsRef.current
			const scope = scopeRef.current
			if (!sessions || !scope || !conversationMaterializedRef.current || !session?.hasProvider)
				return false
			const resumedSessionId = scope.sessionId
			const active = await activeConversationTurn(sessions, resumedSessionId).catch(() => undefined)
			if (!active) return false
			if (abortRef.current || state !== 'idle') {
				pushMessage(
					'system',
					'Wait for the current reply to finish before continuing the paused one.',
				)
				return true
			}
			setHandoffPark(null)
			const ac = new AbortController()
			abortRef.current = ac
			setState('thinking')
			thinkingForNextRowRef.current = ''
			const st: StreamState = {
				assistantId: null,
				text: '',
				conversationMessages: undefined,
				pending: '',
				completed: false,
				outcome: null,
				sessionId: scope.sessionId,
				notification: null,
			}
			liveStreamRef.current = st
			let scheduledRun = false
			let restoreBrowser: (() => Promise<void>) | undefined
			try {
				// A scheduled run parked on a decision: the operator answers the
				// parked batch here, and the turn continues under the job's rules.
				const scheduled = active.paused
					? await scheduleRef.current?.prepareResume(permissionModeRef.current, {
							cwd: ctxRef.current.cwd,
							roots: session.directories?.list() ?? [],
							sandboxed: session.sandbox.workspace !== 'host',
							// The resumed turn runs on the job's provider: one this
							// session has no credential for is refused before asking.
							providers: detected.map((item) => item.entry.id),
							browser: session.browser !== undefined,
						})
					: undefined
				if (scheduled && 'leave' in scheduled) {
					pushMessage('system', 'The scheduled run stays waiting. /resume asks again.')
					return true
				}
				if (scheduled && 'abandon' in scheduled) {
					scheduledRun = true
					if (!session.abandonTurn) throw new Error('this session cannot abandon turns')
					await session.abandonTurn(active.turnId as TurnId, scheduled.abandon)
					pushMessage('system', PAUSED_TURN_LINES.abandonedScheduled)
					return true
				}
				scheduledRun = scheduled !== undefined
				const { browser: jobBrowser, ...scheduledParams } = scheduled ?? {}
				// A job's browser grant: this turn drives the job's profile, held
				// to its sites, and the session's own comes back when it ends.
				if (jobBrowser && session.browser) {
					restoreBrowser = await session.browser.runAs(jobBrowser)
					pushMessage(
						'system',
						`The browser uses the job’s profile ${jobBrowser.profile} for this run, on its sites only.`,
					)
				}
				// Said once the turn really continues: a scheduled park can still
				// be left waiting or abandoned above.
				pushMessage('system', PAUSED_TURN_LINES.resuming)
				for await (const event of session.resumePaused({
					turnId: active.turnId,
					signal: ac.signal,
					...(scheduled
						? scheduledParams
						: {
								// The operator's mode, read at every decision like a new turn's:
								// `/resume` in plan mode stays read-only, and so do its children.
								permissionMode: permissionModeRef.current,
								currentPermissionMode: () => permissionModeRef.current,
								onAutoModeLimit: handleAutoModeLimit,
								...(resume?.handoffReason
									? {
											systemNote: handoffContinuationNote(resume.handoffReason),
										}
									: {}),
							}),
				})) {
					applyEventRef.current?.(event, st)
				}
				flushStream(st)
				if (st.assistantId) finalizeMessage(st.assistantId)
				// The resumed segment was appended to the log; the fold is the context
				// the next prompt continues from.
				modelHistoryRef.current = await loadConversation(sessions, resumedSessionId)
				// A successfully completed checkpoint frees the conversation's active
				// slot. Only then may prompts queued behind the paused turn start. A
				// repeated pause, failed resume, unreadable log, or conversation switch
				// keeps dependent work held for an explicit operator decision.
				if (
					st.completed &&
					queuePauseRef.current?.outcome === 'paused' &&
					scopeRef.current?.sessionId === resumedSessionId &&
					(await activeConversationTurn(sessions, resumedSessionId)
						.then((next) => next === undefined)
						.catch(() => false))
				) {
					advanceQueueContinuation()
				}
			} catch (err) {
				pushSystem('error', explainFailure(err, 'Couldn’t continue this reply.'))
			} finally {
				if (abortRef.current === ac) abortRef.current = null
				setState('idle')
				// A scheduled run answered here records its end in its job now —
				// completed, failed or cancelled — not at a scheduler's next tick,
				// which may never come. One that parked again stays waiting.
				if (scheduledRun) await scheduleRef.current?.settleAnswered()
				await restoreBrowser?.().catch(() => undefined)
			}
			return true
		},
		[
			advanceQueueContinuation,
			detected,
			finalizeMessage,
			flushStream,
			handleAutoModeLimit,
			pushMessage,
			session,
			setHandoffPark,
			state,
			pushSystem,
		],
	)

	// `namzu resume <id>` of a scheduled run parked on a decision: what the
	// notification and `/schedule` tell the operator to run. Continue it once
	// the screen is ready, exactly as `/resume` would, so the parked call is on
	// the permission screen; the job and session checks in `prepareResume`
	// still refuse a session that does not run as the job does. Any other
	// parked or interrupted turn is left for the operator's own `/resume`.
	useEffect(() => {
		const requested = pendingScheduledResumeRef.current
		if (!requested || phase !== 'ready' || state !== 'idle' || !session?.hasProvider) return
		const sessions = sessionsRef.current
		if (!sessions || scopeRef.current?.sessionId !== requested || abortRef.current) return
		pendingScheduledResumeRef.current = null
		void (async () => {
			const active = await activeConversationTurn(sessions, asSessionId(requested)).catch(
				() => undefined,
			)
			if (!active?.paused || !(await scheduleRef.current?.isParked())) return
			if (scopeRef.current?.sessionId !== requested) return
			await resumeActiveTurn()
		})()
	}, [phase, resumeActiveTurn, session, state])

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const doResume = useCallback(
		async (query?: string) => {
			const sessions =
				sessionsRef.current ?? (await ensureSessions().then(() => sessionsRef.current))
			if (!sessions) {
				pushMessage('system', 'Conversation history is unavailable in this folder.')
				return
			}
			if (await resumeActiveTurn()) return
			try {
				const owner = palDefinitionRef.current
				const recent = owner
					? (await listPalConversations(owner.workspace, owner.id)).map((row) => ({
							...row,
							id: asSessionId(row.id),
						}))
					: await listRecent(sessions)
				// Don't offer the active (empty/just-started) conversation.
				const needle = query?.trim().toLowerCase()
				const others = recent.filter(
					(c) =>
						c.id !== scopeRef.current?.sessionId &&
						(!needle ||
							c.title.toLowerCase().includes(needle) ||
							(c.preview?.toLowerCase().includes(needle) ?? false)),
				)
				if (others.length === 0) {
					pushMessage(
						'system',
						needle
							? `No conversation in this folder matches "${query?.trim()}". /resume lists them all.`
							: 'No past conversations to resume in this folder yet.',
					)
					return
				}
				setResumeList(others)
				setSelectedResume(0)
				setPhase('resume')
			} catch (err) {
				pushSystem('error', explainFailure(err, 'Could not list conversations.'))
			}
		},
		[ensureSessions, pushMessage, resumeActiveTurn],
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const doUnarchive = useCallback(async () => {
		if (palDefinitionRef.current) {
			pushMessage(
				'system',
				'Restoring archived Pal conversations is not available in this terminal yet.',
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
				'Wait for the current reply and queued messages to finish before restoring a conversation.',
			)
			return
		}
		const sessions = sessionsRef.current ?? (await ensureSessions().then(() => sessionsRef.current))
		if (!sessions) {
			pushMessage('system', 'Conversation history is unavailable in this folder.')
			return
		}
		try {
			const archived = await listArchived(sessions, 100)
			if (archived.length === 0) {
				pushMessage('system', 'No archived conversations in this project.')
				return
			}
			setResumeList(archived)
			setSelectedResume(0)
			setPhase('unarchive')
		} catch (err) {
			pushSystem('error', explainFailure(err, 'Could not list archived conversations.'))
		}
	}, [ensureSessions, hasUnsettledTurn, pushMessage, state])

	// The options `permissionAnswers` needs for the prompt on screen, so the
	// keys and the box number the same answers.
	const permissionAnswerOptions = (pending: PendingPermission) => ({
		batchOnly: pending.batchOnly === true,
		screenConsent: pending.screenConsent === true,
		withheld: pending.withheld.length > 0,
		endsTurn: endsTurnOnNo(pending),
		mode: permissionModeRef.current,
		...(session?.allowForSession && session.commandArguments
			? {
					commandArguments: session.commandArguments,
					rememberWhere: displayPath(ctx.cwd, 28),
				}
			: {}),
	})

	// Resolve a pending permission prompt with the user's decision and tear
	// down the overlay. No-op if nothing is pending.
	const resolvePermission = useCallback((requested: PermissionDecision) => {
		const shown = permissionShownRef.current
		if (!shown) return
		// The screen may show a bounded view, but a yes only binds the input
		// that was shown: the hash is the binding. It is taken again over the
		// request the SDK holds and will run, and must equal what the person
		// saw. A call that was never shown (a rule or the mode approved it while
		// it waited) is not checked here; the kernel records it as approved
		// without being shown.
		let decision = requested
		if (requested.kind === 'approve') {
			const again = buildPermissionReview(shown.source.toolCalls)
			if (!again.ok || again.envelopeHash !== shown.envelopeHash)
				decision = {
					kind: 'reject',
					feedback: 'Refused: the tool input changed after it was shown for approval.',
				}
		}
		// The provider resumes asynchronously after the decision. Leaving the
		// old state in place during that hand-off painted an empty `…` row and
		// the now-invalid approval footer, so a four-agent batch looked frozen
		// precisely while its children were starting. The turn is working from
		// the instant consent resolves; the next tool event will refine this to
		// `tool`, and the ordinary turn finalizer owns the transition to idle.
		setState('thinking')
		// A plain No that ends the turn leaves one interruption row when the turn closes.
		if (decision.kind === 'reject' && decision.endTurn === true) refusalEndedTurnRef.current = true
		permissionAsksRef.current?.answer(decision)
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
	const interruptTurn = useCallback(
		(recoverInput = false): boolean => {
			const cancelledSwitch = cancelPendingModelSwitch()
			permissionAsksRef.current?.closeAll({ kind: 'reject', feedback: 'User interrupted.' })
			const ac = abortRef.current
			if (!ac) {
				// A prompt still at the turn boundary: nothing has begun, so taking
				// the slot back is the whole interrupt. It drops itself when its
				// await returns.
				if (admissionRef.current) {
					admissionRef.current = null
					const activeSessionId = scopeRef.current?.sessionId
					if (activeSessionId) goalActivation.disarm(activeSessionId)
					wakeGoalDriver()
					if (recoverInput && queuedRef.current.length > 0)
						setQueuePause({ outcome: 'stopped', source: 'operator-interrupt' })
					else discardQueued()
					setState('idle')
					return true
				}
				if (cancelledSwitch) {
					if (recoverInput && queuedRef.current.length > 0)
						setQueuePause({ outcome: 'stopped', source: 'operator-interrupt' })
					else discardQueued()
				}
				return cancelledSwitch
			}
			ac.abort(new TurnCancelled('user'))
			// Esc with a pending steer means "let this instruction interrupt the
			// answer". The kernel has not drained these inputs yet, so reclaim them
			// before closing the inbox and let the queue pump start them first after
			// the aborted turn settles. Ctrl+C keeps its deliberate cancel-all path.
			const undeliveredSteers = recoverInput ? (activeTurnInboxRef.current?.close() ?? []) : []
			const activeSessionId = scopeRef.current?.sessionId
			if (activeSessionId) goalActivation.disarm(activeSessionId)
			wakeGoalDriver()
			activeTurnTokenRef.current = null
			activeTurnInboxRef.current = null
			setPendingSteers([])
			// Dropped now so a second interrupt does not re-abort.
			abortRef.current = null
			if (recoverInput && undeliveredSteers.length > 0) {
				replaceQueued([...undeliveredSteers.map((input) => input.prompt), ...queuedRef.current])
				setQueuePause(null)
			} else if (recoverInput && queuedRef.current.length > 0) {
				// Esc without a pending steer stops the current turn; queued future
				// instructions stay visible but do not start on a cancelled answer.
				setQueuePause({ outcome: 'stopped', source: 'operator-interrupt' })
			} else discardQueued()
			clearActiveTools()
			setSummarising(false)
			setState('idle')
			return true
		},
		[
			cancelPendingModelSwitch,
			clearActiveTools,
			discardQueued,
			goalActivation,
			replaceQueued,
			setQueuePause,
			wakeGoalDriver,
		],
	)
	/**
	 * The one way a turn is interrupted from the keyboard: stop it, then leave
	 * the one interruption row behind. The row hangs under the call that was
	 * running when there was one (read before the stop clears it), and says
	 * only "Interrupted" after a send-now steer, whose answer is already on its
	 * way. `always` draws the row even when nothing was running to stop.
	 */
	const interruptWithRow = useCallback(
		(
			recoverInput: boolean,
			options?: { readonly steered?: boolean; readonly always?: boolean },
		) => {
			const callRunning = activeToolsRef.current.length > 0
			const interrupted = interruptTurn(recoverInput)
			if (interrupted || options?.always === true) {
				const row = interruptionRow({
					callRunning,
					...(options?.steered ? { steered: true } : {}),
				})
				pushMessage('system', row.content, false, row.glyph, undefined, row.color)
			}
			return interrupted
		},
		[interruptTurn, pushMessage],
	)
	/**
	 * ctrl+x ctrl+s: send what is waiting now. Same effect as Esc with a
	 * pending steer (the reply stops, the steer starts the next one); a queue
	 * that was only held by that interruption is released so it runs too.
	 */
	const sendPendingNow = useCallback(() => {
		if (!abortRef.current) return
		interruptWithRow(true, { steered: true, always: true })
		if (queuePauseRef.current?.source === 'operator-interrupt') setQueuePause(null)
	}, [interruptWithRow, setQueuePause])

	// A termination signal leaves like `/exit`, after stopping the turn: the
	// session still owns tool servers, jobs and the `session_end` hook, and
	// Ink's unmount is what gives the terminal back.
	useEffect(() => {
		if (!terminationExit) return
		terminationExit.current = () => {
			interruptTurn()
			exitWithSummary()
		}
		return () => {
			terminationExit.current = null
		}
	}, [terminationExit, interruptTurn, exitWithSummary])

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
	 * `SessionScope` the running loop held the very same object of.
	 *
	 * The mutation below stays, and it is the sharing that makes it necessary:
	 * `createAgentSession` closed over this exact object and spreads it into
	 * every `query()`, so replacing it here would leave the agent attributing
	 * every future turn to the conversation the operator has left. `SessionScope`
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
			if (
				palDefinitionRef.current &&
				(abortRef.current || hasUnsettledTurn() || queuedRef.current.length > 0)
			) {
				setPhase('ready')
				pushMessage(
					'system',
					'Wait for this Pal’s current reply and queued messages to finish before opening another conversation.',
				)
				return
			}
			// The operator has committed; `Esc` no longer cancels from here, or a
			// press landing during the read would leave the picker closed and the
			// switch happening anyway.
			resumeCommittedRef.current = true
			let msgs: Awaited<ReturnType<typeof loadConversation>>
			try {
				await tuiPalDefinition(ctxRef.current.cwd, conv.id, ctxRef.current.palId)
				await requireWritableConversation(sessions, conv.id, 'resume conversation')
				msgs = await loadConversation(sessions, conv.id)
			} catch (err) {
				resumeCommittedRef.current = false
				setPhase('ready')
				pushSystem('error', explainFailure(err, 'Could not resume that conversation.'))
				return
			}
			resumeCommittedRef.current = false
			setPhase('ready')
			const restored = projectConversation(msgs, nextId, [], {
				trail: trailFromRecords(journalOf(msgs)),
				cwd: ctxRef.current.cwd,
			})
			// A queue can outlive its turn by one render: the turn has set idle and
			// cleared `abortRef`, while the passive queue pump is paused behind this
			// picker. `interruptTurn` correctly reports no RUNNING turn then, but an
			// early return from it must not make those old prompts cross the switch.
			const discardedQueued = queuedRef.current.length
			const interrupted = interruptTurn()
			discardQueued()
			goalActivation.clear()
			wakeGoalDriver()
			cancelPendingModelSwitch()
			conversationGenRef.current += 1
			resetSubagentActivity()
			session?.resetTaskStore?.()
			activeTurnTokenRef.current = null
			resetTranscript()
			setMessages(restored)
			modelHistoryRef.current = msgs
			setHistory((previous) => [...previous, ...promptHistoryFromConversation(msgs)])
			// Persisted conversation rows do not carry the live run/message identity
			// required by feedback validation. Do not leave the answer from the
			// conversation we just exited as a hidden `/feedback` target.
			lastAssistantMessage.current = null
			const persistedOutput = latestAssistantOutput(msgs)
			lastCompletedOutputRef.current = persistedOutput
				? { text: persistedOutput, provenance: 'persisted' }
				: null
			pendingGoalResumeRef.current = conv.id
			scope.sessionId = conv.id // new turns now attribute to the resumed session
			if (palDefinitionRef.current) {
				setPhase('probing')
				palRouteSessionRef.current = null
				try {
					await session?.close()
					if (!savedPrefsRef.current) throw new Error('Select a model for this Pal conversation.')
					await hydrateSession(savedPrefsRef.current, detected)
				} catch (error) {
					setPhase('unhealthy')
					pushMessage(
						'system',
						explainFailure(error, 'Could not start this Pal conversation.'),
						false,
						STARTUP_STOP_GLYPH,
					)
				}
			}
			// The scope now names the resumed conversation, so its finished
			// children are readable. Without this the first Ctrl+T after a resume
			// would have nothing to find.
			void hydrateSavedChildren()
			conversationMaterializedRef.current = true
			sourceDeliveryPollRef.current()
			pushMessage('system', `Resumed: ${displayConversationTitle(conv.title)}`)
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
				// the turn says so itself, in the same words `exec --json` uses.
				pushMessage(
					'system',
					'The reply that was running was stopped. What it had written so far is being saved to the conversation it started in, so it is not in the transcript above. A tool call that had already started was not undone.',
				)
			}
		},
		[
			discardQueued,
			goalActivation,
			interruptTurn,
			nextId,
			pushMessage,
			cancelPendingModelSwitch,
			hydrateSavedChildren,
			hasUnsettledTurn,
			hydrateSession,
			detected,
			resetSubagentActivity,
			session,
			resetTranscript,
			wakeGoalDriver,
			pushSystem,
		],
	)

	const restoreArchivedConversation = useCallback(
		async (conv: RecentConversation) => {
			const sessions = sessionsRef.current
			if (!sessions) {
				setPhase('ready')
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
				setPhase('ready')
				pushMessage(
					'system',
					'Wait for the current reply and queued messages to finish before restoring a conversation.',
				)
				return
			}
			resumeCommittedRef.current = true
			try {
				await unarchiveConversation(sessions, conv.id)
			} catch (err) {
				resumeCommittedRef.current = false
				setPhase('ready')
				pushMessage(
					'system',
					err instanceof ConversationIndexRefreshError
						? err.message
						: explainFailure(err, 'Could not restore that conversation.'),
				)
				return
			}
			pushMessage('system', `Restored: ${displayConversationTitle(conv.title)}`)
			try {
				await resumeConversation(conv)
			} finally {
				resumeCommittedRef.current = false
			}
		},
		[hasUnsettledTurn, pushMessage, resumeConversation, state],
	)

	/**
	 * Start a new conversation without deleting the one being left.
	 *
	 * The durable target is created first. `startConversation` can fail, and an
	 * operator who asked for a new chat must not lose a running turn merely
	 * because its empty successor could not be published. Once it exists, moving
	 * the shared scope and advancing the generation are one synchronous boundary:
	 * old events can still unwind and persist to their captured destination, but
	 * they cannot render into or start an SDK turn under the new conversation.
	 *
	 * A process whose initial persistence setup failed has no shared scope to
	 * move. It still gets an honest in-memory context reset; the notice names that
	 * it is not resumable instead of claiming a durable chat was created.
	 */
	const startFreshConversation = useCallback(
		async (clearScreen: boolean) => {
			if (conversationMutationRef.current) return
			if (
				palDefinitionRef.current &&
				(abortRef.current || hasUnsettledTurn() || queuedRef.current.length > 0)
			) {
				pushMessage(
					'system',
					'Wait for this Pal’s current reply and queued messages to finish before starting another conversation.',
				)
				return
			}
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
					if (palDefinitionRef.current) {
						targetSessionId = generateSessionId()
						await claimPalConversation(
							ctxRef.current.cwd,
							palDefinitionRef.current.id,
							targetSessionId,
						)
					} else targetSessionId = await startConversation(sessions)
				}

				const discardedQueued = queuedRef.current.length
				const interrupted = interruptTurn()
				discardQueued()
				goalActivation.clear()
				wakeGoalDriver()
				cancelPendingModelSwitch()
				conversationGenRef.current += 1
				resetSubagentActivity()
				session?.resetTaskStore?.()
				activeTurnTokenRef.current = null
				modelHistoryRef.current = []
				lastAssistantMessage.current = null
				lastCompletedOutputRef.current = null
				if (sourceScope && targetSessionId) {
					sourceScope.sessionId = targetSessionId
					conversationMaterializedRef.current = true
					sourceDeliveryPollRef.current()
					// A fresh conversation owns no turns yet, so this normally reads
					// nothing. It runs anyway because the rule is "the scope changed,
					// re-read", and an exception here is how the resume path lost
					// its own re-read.
					void hydrateSavedChildren()
					if (palDefinitionRef.current) {
						setPhase('probing')
						palRouteSessionRef.current = null
						try {
							await session?.close()
							if (!savedPrefsRef.current)
								throw new Error('Select a model for this Pal conversation.')
							await hydrateSession(savedPrefsRef.current, detected)
						} catch (error) {
							setPhase('unhealthy')
							pushMessage(
								'system',
								explainFailure(error, 'Could not start this Pal conversation.'),
								false,
								STARTUP_STOP_GLYPH,
							)
						}
					}
				}

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
									: ' Earlier rows above are display only and are not part of this conversation’s model context.'
							}`
						: `Started a fresh conversation. Conversations cannot be saved right now, so this one is lost when you quit.${
								clearScreen
									? ''
									: ' Earlier rows above are display only and are not part of this conversation’s model context.'
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
						'The reply that was running was stopped. What it had written so far is being saved to the conversation it started in; a tool call that had already started was not undone.',
					)
				}
			} catch (err) {
				pushSystem(
					'error',
					explainFailure(
						err,
						'Couldn’t start a new conversation. The current one and any running reply are unchanged.',
					),
				)
			} finally {
				conversationMutationRef.current = null
				setConversationMutation(null)
			}
		},
		[
			discardQueued,
			goalActivation,
			interruptTurn,
			pushMessage,
			cancelPendingModelSwitch,
			hydrateSavedChildren,
			hasUnsettledTurn,
			hydrateSession,
			detected,
			resetSubagentActivity,
			session,
			resetTranscript,
			wakeGoalDriver,
			pushSystem,
		],
	)

	/** Save a title the model wrote, once no turn holds the log. A busy log is tried again at the next turn's end. */
	const flushGeneratedTitle = useCallback(async () => {
		const pending = pendingGeneratedTitleRef.current
		const sessions = sessionsRef.current
		if (!pending || !sessions) return
		try {
			await recordGeneratedTitle(sessions, pending.sessionId, pending.title)
			if (pendingGeneratedTitleRef.current === pending) pendingGeneratedTitleRef.current = undefined
		} catch {
			// The log is held by a turn; the turn's end calls this again.
		}
	}, [])

	/**
	 * After a conversation's first message, ask the small model for a name.
	 *
	 * A side job: it runs beside the turn, never delays or fails it, and a
	 * conversation that already has a name or a title is left alone. The title
	 * shows at once in the terminal title and is saved for `/resume` when the log
	 * is free.
	 */
	const startGeneratedTitle = useCallback(
		(sideModel: SideModel | undefined, sessionId: SessionId, turnId: TurnId, message: string) => {
			const sessions = sessionsRef.current
			if (!sideModel || !sessions || generatedTitleAttemptedRef.current.has(sessionId)) return
			generatedTitleAttemptedRef.current.add(sessionId)
			const typed = typedTextOf(message)
			const text = typed.text.trim() ? typed.text : (typed.firstFile ?? '')
			void (async () => {
				try {
					const existing = await titlesOf(sessions, sessionId)
					if (existing.named !== undefined || existing.generated !== undefined) return
					const title = await generateTitle({
						sideModel,
						sessionId,
						turnId,
						message: text,
						signal: AbortSignal.timeout(30_000),
					})
					if (title === undefined) {
						generatedTitleAttemptedRef.current.delete(sessionId)
						return
					}
					pendingGeneratedTitleRef.current = { sessionId, title }
					if (scopeRef.current?.sessionId === sessionId) {
						setConversationNames((names) =>
							names.named !== undefined ? names : { generated: title },
						)
					}
					// Saved at the end of a turn (or now, if none is running), never
					// while one starts: the turn's claim on the log does not wait.
					if (activeTurnTokenRef.current === null && queuedRef.current.length === 0) {
						await flushGeneratedTitle()
					}
				} catch {
					generatedTitleAttemptedRef.current.delete(sessionId)
				}
			})()
		},
		[flushGeneratedTitle],
	)

	// The names of whichever conversation is open, read when it changes: a resume,
	// a new conversation and a clear all move `scopeRef`, and this follows it.
	useEffect(() => {
		const sessionId = scopeRef.current?.sessionId
		if (sessionId === namesSessionRef.current) return
		namesSessionRef.current = sessionId
		// A different conversation: nothing about the old one's countdown applies.
		awayRecapRef.current?.reset()
		manualRecapRef.current?.abort()
		setConversationNames({})
		const sessions = sessionsRef.current
		if (!sessionId || !sessions || !conversationMaterializedRef.current) return
		// Read inside an async function so a store that cannot answer is a rejection
		// here, never an error thrown into the render.
		void (async () => titlesOf(sessions, sessionId))().then(
			(titles) => {
				if (namesSessionRef.current === sessionId) setConversationNames(titles)
			},
			() => undefined,
		)
	})

	// The terminal's own title: the conversation's name, with a glyph that says
	// whether a turn is running. Reset on exit so the shell's title comes back.
	// The glyph moves only while a turn is working with the terminal in view; a
	// permission wait and a terminal multiplexer show the idle glyph.
	const terminalFocused = useTerminalFocused()
	const titleWorking = state === 'thinking' || state === 'tool'
	const motionReduced = useReducedMotion()
	const titleFrame = useTitleFrame(
		!motionReduced &&
			titleAnimates({ working: titleWorking, focused: terminalFocused, env: process.env }),
	)
	const terminalTitle = terminalTitleText({
		...conversationNames,
		busy: titleWorking && !underMultiplexer(process.env),
		frame: titleFrame,
	})
	// Only the terminal this process is attached to has a title of ours to set; an
	// embedding that renders to another stream (a test harness, a pane) is left alone.
	const titledStream = stdout === process.stdout && terminalTitleEnabled(process.env, stdout.isTTY)
	useEffect(() => {
		if (!titledStream) return
		if (lastTerminalTitleRef.current === terminalTitle) return
		lastTerminalTitleRef.current = terminalTitle
		stdout.write(setTerminalTitleSequence(terminalTitle))
	}, [terminalTitle, titledStream, stdout])
	useEffect(() => {
		const reset = () => {
			if (lastTerminalTitleRef.current === undefined) return
			lastTerminalTitleRef.current = undefined
			try {
				stdout.write(RESET_TERMINAL_TITLE_SEQUENCE)
			} catch {
				// The terminal is already gone; there is no title to restore.
			}
		}
		process.once('exit', reset)
		return () => {
			process.removeListener('exit', reset)
			reset()
		}
	}, [stdout])

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
			const scope = await materializeConversation()
			const sessions = sessionsRef.current
			if (!sessions || !scope) {
				pushMessage('system', 'Conversation history is unavailable in this folder.')
				return
			}
			try {
				if (!clear && title === '') {
					const current = await titleOf(sessions, scope.sessionId)
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
				await setTitle(sessions, scope.sessionId, clear ? '' : title)
				setConversationNames(clear || title.trim() === '' ? {} : { named: title.trim() })
				pushMessage(
					'system',
					clear
						? 'Name removed. /resume will list this conversation by its opening message again.'
						: `Named "${title}".`,
				)
			} catch (err) {
				pushSystem('error', explainFailure(err, 'Could not save the name.'))
			}
		},
		[materializeConversation, pushMessage, setTextPrompt, pushSystem],
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const submitTextPrompt = useCallback(
		(value: string) => {
			const prompt = textPromptRef.current
			if (!prompt) return
			setTextPrompt(null)

			if (prompt.kind === 'user-question') {
				const text = value.trim()
				const pending = questionRef.current
				if (text.length === 0) {
					resolveQuestion({ kind: 'skip' })
					return
				}
				if (pending) {
					pushMessage('system', `Answered "${pending.question.question}": ${text}`, false, '?')
				}
				resolveQuestion({
					kind: 'answer',
					selectedOptionIds: [],
					freeText: text,
				})
				return
			}

			const scope = scopeRef.current
			if (!scope || scope.sessionId !== prompt.sessionId) {
				pushMessage(
					'system',
					'The conversation changed while this editor was open. Reopen the command in the current conversation.',
				)
				return
			}
			if (prompt.kind === 'turn-limit') {
				const field = TURN_LIMIT_FIELDS.find((field) => field.key === prompt.limitKey)
				if (field) commandPickerSubmitRef.current(`/config limits ${field.name} ${value.trim()}`)
				return
			}
			if (prompt.kind === 'goal-create' || prompt.kind === 'goal-edit') {
				if (value.trim())
					commandPickerSubmitRef.current(
						`/goal ${prompt.kind === 'goal-create' ? 'set' : 'edit'} ${value.trim()}`,
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
			void setTitle(sessions, prompt.sessionId, value).then(
				() => {
					if (scopeRef.current?.sessionId === prompt.sessionId) {
						setConversationNames(value.trim() === '' ? {} : { named: value.trim() })
					}
					pushMessage('system', `Named "${value.trim()}".`)
				},
				(error: unknown) => pushSystem('error', explainFailure(error, 'Could not save the name.')),
			)
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
			// A cancelled free-text answer is a skipped question, not a hung tool.
			if (prompt?.kind === 'user-question') resolveQuestion({ kind: 'skip' })
		})
	}, [resolveQuestion, setTextPrompt])

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
		if (palDefinitionRef.current) {
			pushMessage(
				'system',
				'Forking Pal conversations is not available yet. Use /new for a separately claimed conversation.',
			)
			return
		}
		if (conversationMutationRef.current) return
		if (abortRef.current) {
			pushMessage(
				'system',
				'A reply is still running. Forking now would copy a conversation whose last reply is not in it yet — press esc to stop it, then fork.',
			)
			return
		}
		if (hasUnsettledTurn()) {
			pushMessage(
				'system',
				'A reply was stopped and is still being saved. Wait for it to finish before forking.',
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
			const scope = await materializeConversation()
			const sessions = sessionsRef.current
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
			// The fork owns the displayed history, except for host-only results
			// delivered to the original conversation's sidecar inbox.
			scope.sessionId = forked.id
			// The copy's own history: the original's messages name ids the copy's
			// log never gave out, and the next send would be refused.
			modelHistoryRef.current = forked.messages
			resetTranscript()
			setMessages((previous) => previous.filter((message) => !message.sourceDelivery))
			sourceDeliveryPollRef.current()
			resetSubagentActivity()
			void hydrateSavedChildren()
			session?.resetTaskStore?.()
			goalActivation.clear()
			wakeGoalDriver()
			pushMessage(
				'system',
				`Forked into "${displayConversationTitle(forked.title)}" — ${plural(forked.copied, 'message')} copied. This screen continues in the copy; ${original} is unchanged and still in /resume.`,
			)
		} catch (err) {
			pushSystem('error', explainFailure(err, 'Could not fork.'))
		} finally {
			conversationMutationRef.current = null
			setConversationMutation(null)
		}
	}, [
		goalActivation,
		hasUnsettledTurn,
		materializeConversation,
		pushMessage,
		hydrateSavedChildren,
		resetTranscript,
		resetSubagentActivity,
		session,
		wakeGoalDriver,
		pushSystem,
	])

	/** Open the rewind picker after the composer's second empty Esc, or `/rewind`. */
	const openPromptEditor = useCallback(() => {
		if (palDefinitionRef.current) {
			pushMessage('system', 'Rewinding is not available in a Pal conversation yet.')
			return
		}
		if (conversationMutationRef.current || compactingRef.current) return
		if (abortRef.current || state !== 'idle' || hasUnsettledTurn()) {
			pushMessage(
				'system',
				'A reply is still running or being saved. Wait for it to finish before rewinding.',
			)
			return
		}
		if (queuedRef.current.length > 0) {
			pushMessage('system', 'Queued prompts must finish before the conversation can be rewound.')
			return
		}
		const history = modelHistoryRef.current
		if (history.length === 0 && messages.length === 0) return
		const candidates = editablePrompts(history, messages)
		const store = session?.checkpoints
		void (async () => {
			if (store) await store.open().catch(() => undefined)
			const rows = buildRewindRows(candidates, store ? store.list() : undefined, history)
			const generation = rewindGenRef.current + 1
			rewindGenRef.current = generation
			setEditList(candidates)
			editCommittedRef.current = false
			setRewindView({ rows, state: openRewind(rows.length), openedAt: Date.now() })
			setPhase('edit')
			if (!store) return
			// Newest first and under one budget; the dialog is usable meanwhile.
			void countRewindRows(rows, (from, expired) => store.rewindSummary(from, expired), {
				now: Date.now,
				budgetMs: REWIND_COUNT_BUDGET_MS,
				onRow: (index, summary) => {
					const current = rewindRef.current
					if (!current || rewindGenRef.current !== generation) return
					setRewindView({
						...current,
						rows: current.rows.map((row, at) =>
							at === index && row.files.kind === 'changes'
								? { ...row, files: { ...row.files, summary } }
								: row,
						),
					})
				},
			})
		})()
	}, [hasUnsettledTurn, messages, pushMessage, session, setRewindView, state])

	/** `/restore`: list the file checkpoints, or put the tree back to before a turn. */
	const doRestore = useCallback(
		async (turn: number | undefined) => {
			const store = session?.checkpoints
			if (!store) {
				pushMessage(
					'system',
					'File changes are not being saved in this conversation, so there is nothing to restore.',
				)
				return
			}
			// A reopened conversation's history is on disk, not yet in memory.
			await store.open().catch(() => undefined)
			if (turn === undefined) {
				pushMessage(
					'system',
					renderCheckpoints(store.list(), ctxRef.current.cwd, store.skippedPaths()),
				)
				return
			}
			if (abortRef.current || state !== 'idle' || hasUnsettledTurn()) {
				pushMessage(
					'system',
					'A reply is still running. Wait for it, or stop it, before restoring files.',
				)
				return
			}
			try {
				const report = await store.restore(turn)
				const text = renderRestore(report, ctxRef.current.cwd)
				pushMessage('system', text)
				// The model's picture of those files is now wrong; it reads
				// this before its next turn.
				operatorShellRef.current.push(renderRestoreNote(report, ctxRef.current.cwd))
			} catch (err) {
				pushSystem('error', explainFailure(err, 'Could not restore the files.'))
			}
		},
		[hasUnsettledTurn, pushMessage, session, state, pushSystem],
	)

	/**
	 * Continue the conversation from before the selected prompt: write a fork
	 * holding everything ahead of it, switch to it, and put the prompt back in
	 * the composer. The original stays unchanged and in /resume. Throws a plain
	 * sentence when it cannot.
	 */
	const forkBeforePrompt = useCallback(
		async (target: EditablePrompt) => {
			if (editCommittedRef.current || conversationMutationRef.current) return
			if (hasUnsettledTurn() || queuedRef.current.length > 0) {
				throw new Error(
					'The conversation changed while the rewind dialog was open. Nothing was changed; open it again.',
				)
			}

			editCommittedRef.current = true
			conversationMutationRef.current = 'edit'
			setConversationMutation('edit')
			const generation = conversationGenRef.current
			try {
				const sessions =
					sessionsRef.current ?? (await ensureSessions().then(() => sessionsRef.current))
				const scope = scopeRef.current
				if (!sessions || !scope) {
					throw new Error('Conversation history is unavailable in this folder.')
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

				cancelPendingModelSwitch()
				conversationGenRef.current += 1
				resetSubagentActivity()
				session?.resetTaskStore?.()
				activeTurnTokenRef.current = null
				goalActivation.clear()
				wakeGoalDriver()
				scope.sessionId = forked.id
				conversationMaterializedRef.current = true
				sourceDeliveryPollRef.current()
				void hydrateSavedChildren()
				modelHistoryRef.current = forked.messages
				lastAssistantMessage.current = null
				const persistedOutput = latestAssistantOutput(forked.messages)
				lastCompletedOutputRef.current = persistedOutput
					? { text: persistedOutput, provenance: 'persisted' }
					: null

				resetTranscript()
				setMessages(
					projectConversation(forked.messages, nextId, readablePrefix, { cwd: ctxRef.current.cwd }),
				)
				composerDraftTokenRef.current += 1
				setComposerDraft({
					token: composerDraftTokenRef.current,
					text: target.displayText,
					...(forked.selected.attachments && forked.selected.attachments.length > 0
						? { attachments: [...forked.selected.attachments] }
						: {}),
				})
				setEditList([])
				setRewindView(null)
				setPhase('ready')
				pushMessage(
					'system',
					`Forked into "${displayConversationTitle(forked.title)}" before the selected prompt. Edit it below; the original is unchanged and remains in /resume.`,
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
			cancelPendingModelSwitch,
			hydrateSavedChildren,
			resetSubagentActivity,
			session,
			resetTranscript,
			setRewindView,
			wakeGoalDriver,
		],
	)

	/** Put the files back to before the chosen prompt, through the drift-checked plan. */
	const rewindCode = useCallback(
		async (row: RewindRow) => {
			const store = session?.checkpoints
			if (!store || row.files.kind !== 'changes') {
				throw new Error('There is no saved file history to restore from.')
			}
			await store.open()
			const report = await store.restore(row.files.restoreFrom)
			if (report.restored.length + report.removed.length === 0 && report.failed.length > 0) {
				const n = report.failed.length
				throw new Error(
					`No files were restored: ${n} ${n === 1 ? 'file' : 'files'} failed (the saved copy is missing, or the file could not be updated).`,
				)
			}
			return report
		},
		[session],
	)

	/** Summarise the conversation before or from the chosen prompt, in place. */
	const rewindSummarize = useCallback(
		async (target: EditablePrompt, option: 'summarize' | 'summarize_up_to', context?: string) => {
			const compactRange = session?.compactRange
			if (!compactRange) throw new Error('This conversation cannot be summarized.')
			const history = modelHistoryRef.current
			if (!history.includes(target.message)) {
				throw new Error(
					'That message is no longer in the active context. Choose a more recent message.',
				)
			}
			if (compactingRef.current) return
			compactingRef.current = true
			try {
				const result = await compactRange({
					messages: history,
					...(option === 'summarize' ? { from: target.message } : { until: target.message }),
					...(context ? { instructions: context } : {}),
				})
				if (!result)
					throw new Error('There is nothing to summarize in that part of the conversation.')
				modelHistoryRef.current = [...result.messages]
				// The history is shorter: the meter and the idle compactor wait for the next reply's size.
				setContextHidden(true)
				if (idleCompactionRef.current) idleCompactionRef.current.contextTokens.current = undefined
				const at = editList.indexOf(target)
				const readable =
					option === 'summarize'
						? editList.slice(0, Math.max(0, at)).map((prompt) => prompt.displayText)
						: editList.slice(Math.max(0, at)).map((prompt) => prompt.displayText)
				resetTranscript()
				setMessages(
					projectConversation(result.messages, nextId, readable, { cwd: ctxRef.current.cwd }),
				)
				if (option === 'summarize') {
					composerDraftTokenRef.current += 1
					setComposerDraft({
						token: composerDraftTokenRef.current,
						text: target.displayText,
						...(target.message.attachments && target.message.attachments.length > 0
							? { attachments: [...target.message.attachments] }
							: {}),
					})
				}
				setCompactionTally((tally) => ({
					...tally,
					passes: tally.passes + 1,
					summaries: tally.summaries + 1,
				}))
				setEditList([])
				setRewindView(null)
				setPhase('ready')
				pushMessage('system', 'Conversation summarized.')
			} finally {
				compactingRef.current = false
			}
		},
		[editList, nextId, pushMessage, resetTranscript, session, setRewindView],
	)

	/** Carry out a choice made in the rewind dialog. Errors stay inside the dialog. */
	const runRewindChoice = useCallback(
		async (
			rowIndex: number,
			option: Exclude<RewindOption, 'nevermind'>,
			context: string | undefined,
		) => {
			const view = rewindRef.current
			const row = view?.rows[rowIndex]
			const prompt = row?.prompt
			if (!view || !row || !prompt) return
			if (editCommittedRef.current || conversationMutationRef.current) return
			const settle = (error?: string) => {
				const latest = rewindRef.current ?? view
				setRewindView({
					...latest,
					state: { ...latest.state, busy: undefined, ...(error ? { error } : {}) },
				})
			}
			if (hasUnsettledTurn() || queuedRef.current.length > 0) {
				settle('The conversation changed while this dialog was open. Nothing was changed.')
				return
			}
			setRewindView({ ...view, state: { ...view.state, busy: option, error: undefined } })
			const plain = (err: unknown) => explainFailure(err, 'Something went wrong.')
			try {
				if (option === 'summarize' || option === 'summarize_up_to') {
					try {
						await rewindSummarize(prompt, option, context)
					} catch (err) {
						settle(`Failed to summarize:\n${plain(err)}`)
					}
					return
				}
				let report: Awaited<ReturnType<typeof rewindCode>> | undefined
				if (option === 'code' || option === 'both') {
					try {
						report = await rewindCode(row)
					} catch (err) {
						settle(`Failed to restore the code:\n${plain(err)}`)
						return
					}
				}
				const announce = () => {
					if (!report) return
					pushMessage('system', renderRestore(report, ctxRef.current.cwd, { before: 'prompt' }))
					// The model's picture of those files is now wrong; it reads
					// this before its next turn.
					operatorShellRef.current.push(renderRestoreNote(report, ctxRef.current.cwd))
				}
				if (option === 'conversation' || option === 'both') {
					try {
						await forkBeforePrompt(prompt)
					} catch (err) {
						announce()
						settle(
							`Failed to restore the ${option === 'both' ? 'conversation and code' : 'conversation'}:\n${plain(err)}`,
						)
						return
					}
					announce()
					return
				}
				setEditList([])
				setRewindView(null)
				setPhase('ready')
				announce()
			} catch (err) {
				settle(plain(err))
			}
		},
		[forkBeforePrompt, hasUnsettledTurn, pushMessage, rewindCode, rewindSummarize, setRewindView],
	)

	// Bridge passed into session.send(): the agent calls this before a
	// non-read-only tool batch (or, asking one call at a time, before each
	// call); it parks until the person answers.
	const onPermission = useCallback(
		(req: ScreenPermissionRequest) => {
			const review = buildPermissionReview(req.toolCalls)
			if (!review.ok) {
				return Promise.resolve<PermissionDecision>({
					kind: 'reject',
					feedback: permissionReviewRefusal(review.reason),
				})
			}
			const summary = buildPermissionSummary(review.text, {
				describeUiRef: (ref) => reviewSessionRef.current?.describeComputerUseRef?.(ref),
				fileExists: (path) => existsSync(resolve(ctxRef.current.cwd, path)),
				workflowLimits: resolveWorkflowLimits(ctxRef.current.workflow),
				withheld: review.withheld,
			})
			const siteNotes = browserSiteNotes(req.toolCalls, browserControlRef.current?.status())
			const pending: PendingPermission = {
				...req,
				review: review.text,
				summary,
				siteNotes,
				withheld: review.withheld,
				source: req,
				envelopeHash: review.envelopeHash,
			}
			const asks = permissionAsksRef.current
			const perCallReview = perCallReviewRef.current
			if (!asks || !perCallReview) {
				return Promise.resolve<PermissionDecision>({
					kind: 'reject',
					feedback: 'The approval screen closed.',
				})
			}
			if (req.perCall) {
				// A call is shown as waiting from the moment it is asked about, and a
				// re-check never lets through a call whose input was not shown in full.
				const presenter = reviewSessionRef.current?.presenter
				for (const [index, call] of req.toolCalls.entries()) {
					perCallReview.hold(
						call.id,
						review.withheld.some((held) => held.index === index),
					)
					const row = presenter
						? queuedToolRow(call, req.turnId, presenter, ctxRef.current.cwd, Date.now())
						: undefined
					if (row) {
						activeToolsRef.current = withQueuedRow(activeToolsRef.current, row as RunningTool)
						setActiveTools(activeToolsRef.current)
					}
				}
			}
			// Another agent's request waits behind every question of the person's
			// own conversation; it never takes the screen from the one already up.
			const background = reviewSource(req, scopeRef.current?.sessionId) !== undefined
			const answered = asks.enqueue(pending, {
				background,
				...(req.signal ? { signal: req.signal } : {}),
			})
			if (asks.shown === pending) announceApproval()
			return answered.then((decision) => {
				if (req.perCall) {
					for (const call of req.toolCalls) {
						perCallReview.release(call.id)
						// A question closed from outside (a rule now covers it, the turn
						// stopped) leaves the row as it is: the kernel's start event takes
						// it over, and the turn's end clears what never started.
						if (decision === CLOSED_QUESTION) continue
						activeToolsRef.current =
							decision.kind === 'approve'
								? (withStartedRow(
										activeToolsRef.current,
										call.id,
										Date.now(),
									) as readonly RunningTool[])
								: (withoutQueuedRow(activeToolsRef.current, call.id) as readonly RunningTool[])
					}
					setActiveTools(activeToolsRef.current)
				}
				return decision
			})
		},
		[announceApproval],
	)

	/**
	 * `ask_user_question`, on screen. The question becomes a finite chooser —
	 * the model's options, then "Something else…" when it allowed free text —
	 * and the tool's promise waits on the row the operator picks. One question
	 * at a time: the tool is not concurrency-safe, so a second cannot arrive
	 * while the first is up.
	 *
	 * `signal`, when the caller has one (the `schedule` tool's confirmation,
	 * which waits on a person and so is given the tool's own abort signal),
	 * is honoured the way `save_skill`'s screen honours the same signal: an
	 * abort — the tool's own deadline elapsing, or the turn stopping —
	 * answers as `abort` and takes the picker off screen, rather than
	 * leaving it live after the tool has already given up on the answer.
	 */
	const askQuestion = useCallback<QuestionFn>(
		(question, signal) =>
			new Promise<QuestionAnswer>((resolve) => {
				if (signal?.aborted) {
					resolve({ kind: 'abort' })
					return
				}
				closeLiveReply()
				questionRef.current = { question, resolve }
				if (needsQuestionDialog(question)) {
					questionDialogTokenRef.current += 1
					const entry = { token: questionDialogTokenRef.current, question }
					const onAbort = () => {
						if (questionDialogRef.current === entry) setQuestionDialog(null)
						resolveQuestion({ kind: 'abort' })
					}
					signal?.addEventListener('abort', onAbort, { once: true })
					setJobSurface(null)
					setQuestionDialog(entry)
					announceApproval()
					return
				}
				const values = [
					...question.options.map((option) => option.id),
					...(question.allowFreeText ? [FREE_TEXT_ANSWER] : []),
				]
				const picker: ChoicePickerState = {
					kind: 'user-question',
					title: question.question,
					notice: question.header
						? `${question.header} · Enter answers · Esc skips`
						: 'Enter answers · Esc skips',
					values,
					options: [
						...question.options.map((option) => ({
							label: option.label,
							description: option.description ?? '',
							// A badge, not label text: the SDK already took any
							// "(Recommended)" the model wrote out of the label.
							...(option.recommended === true ? { recommended: true } : {}),
						})),
						...(question.allowFreeText
							? [
									{
										label: 'Something else…',
										description: 'Answer in your own words',
									},
								]
							: []),
					],
				}
				const onAbort = () => {
					if (choicePickerRef.current === picker) setChoicePicker(null)
					resolveQuestion({ kind: 'abort' })
				}
				signal?.addEventListener('abort', onAbort, { once: true })
				setSelectedChoice(0)
				setJobSurface(null)
				setChoicePicker(picker)
				announceApproval()
			}),
		[
			closeLiveReply,
			announceApproval,
			setChoicePicker,
			setQuestionDialog,
			setSelectedChoice,
			setJobSurface,
			resolveQuestion,
		],
	)
	/**
	 * `exit_plan_mode`, on screen. The box shows the plan from the file; the
	 * answer is applied here, before the tool's promise resolves, so the next
	 * decision of the turn is made under the mode the person picked — through
	 * the same `applyPermissionMode` Shift+Tab uses. Approving also writes the
	 * plan into the transcript; "keep planning" with words leaves those words.
	 */
	const askPlanApproval = useCallback<PlanApprovalFn>(
		(request, signal) =>
			new Promise<PlanApprovalAnswer>((resolve) => {
				if (signal?.aborted) {
					resolve({ kind: 'keep-planning' })
					return
				}
				closeLiveReply()
				const finish = (answer: PlanApprovalAnswer) => {
					signal?.removeEventListener('abort', onAbort)
					// The box answers from its own key handler, which Ink calls before
					// App's; clearing the ref now would hand the same Esc to App as an
					// interrupt of the turn this answer is for.
					queueMicrotask(() => {
						if (planPromptRef.current === entry) setPlanPrompt(null)
					})
					if (answer.kind === 'approve') {
						applyPermissionMode(answer.mode, false)
						pushMessage(
							'system',
							`Plan approved · ${permissionModeLabel(answer.mode)}`,
							false,
							'✓',
							[`Saved to ${request.planPath}`, '', ...request.plan.trimEnd().split('\n')],
						)
					} else if (answer.feedback) {
						// The tool's own row already says the plan was not approved.
						pushMessage('system', `Changes asked for · ${answer.feedback}`)
					}
					resolve(answer)
				}
				const entry = { request, resolve: finish }
				const onAbort = () => finish({ kind: 'keep-planning' })
				signal?.addEventListener('abort', onAbort, { once: true })
				setPlanPrompt(entry)
				announceApproval()
			}),
		[applyPermissionMode, closeLiveReply, pushMessage, announceApproval, setPlanPrompt],
	)
	/**
	 * The card's answer. It answers from its own key handler, which Ink calls
	 * before App's, so the card is taken down a tick later: clearing the ref
	 * now would hand the same Esc or Ctrl+C to App, which reads it as an
	 * interrupt of the turn this answer is for.
	 */
	const finishQuestionDialog = useCallback(
		(answer: QuestionAnswer, summary: readonly string[]) => {
			const entry = questionDialogRef.current
			queueMicrotask(() => {
				if (questionDialogRef.current === entry) setQuestionDialog(null)
			})
			for (const line of summary) pushMessage('system', line, false, '?')
			resolveQuestion(answer)
		},
		[pushMessage, resolveQuestion, setQuestionDialog],
	)
	const submitChildMessage = useCallback(
		async (viewId: string, text: string) => {
			const ownerSession = session
			const child = subagentsRef.current.find((candidate) => candidate.viewId === viewId)
			if (!ownerSession?.messageSubagent || !child || child.replayed) {
				throw new Error('This agent is a saved record and cannot receive messages.')
			}
			if (
				compactingRef.current ||
				conversationMutationRef.current ||
				pendingModelSwitchRef.current
			) {
				throw new Error('Finish the current conversation change before messaging a child.')
			}
			const generation = conversationGenRef.current
			const parentSessionId = scopeRef.current?.sessionId
			const signal = AbortSignal.any([appLifetime.signal, childMessageLifetimeRef.current.signal])
			const owns = () =>
				!signal.aborted &&
				previousSessionRef.current === ownerSession &&
				conversationGenRef.current === generation &&
				scopeRef.current?.sessionId === parentSessionId
			const receipt = await ownerSession.messageSubagent(viewId, text, {
				signal,
				permissionMode: permissionModeRef.current,
				currentPermissionMode: () => permissionModeRef.current,
				onAutoModeLimit: handleAutoModeLimit,
				limits: resolveTurnGuards(ctxRef.current.limits, turnLimitsOverrideRef.current),
				...(reasoningEffortRef.current !== undefined ? { effort: reasoningEffortRef.current } : {}),
				...(hypermodeRef.current ? { hypermode: true } : {}),
				extraSystem: composeSkillsPrompt(activeSkills) || undefined,
				onPermission: async (request) => {
					if (!owns())
						return {
							kind: 'reject',
							feedback: 'The owning conversation changed.',
						}
					const decision = await onPermission(request)
					// A directly continued child can ask while its parent is idle. There
					// is then no parent send finalizer to restore the ordinary input state.
					if (owns() && !abortRef.current && !permissionResolveRef.current) setState('idle')
					return decision
				},
			})
			if (!owns()) return receipt
			const label = `You ${receipt.kind === 'queued' ? 'queued a message' : 'started a follow-up'} for ${child.agentId}.${receipt.auditWarning ? ` ${receipt.auditWarning}` : ''}`
			directChildNoticesRef.current.set(++directChildNoticeIdRef.current, {
				context: receipt.parentNotice,
				label,
				kind: 'advisory',
			})
			// The model is told (above); the person sees their words in the agent's
			// own transcript and `N queued` on its rail row, so main says nothing.
			activeTurnInboxRef.current?.notify()
			return receipt
		},
		[activeSkills, appLifetime.signal, handleAutoModeLimit, onPermission, session],
	)
	const reviewSchedule = useCallback(
		(request: ScheduleReviewRequest, signal?: AbortSignal) =>
			new Promise<ScheduleReviewAnswer>((resolve) => {
				if (signal?.aborted) {
					resolve('cancel')
					return
				}
				closeLiveReply()
				// A second tool call must not replace an open review and leave its
				// Promise waiting forever. Each decision still belongs to its own
				// captured proposal.
				scheduleReviewPromptRef.current?.resolve('cancel')
				let settled = false
				const entry = {
					token: ++scheduleReviewTokenRef.current,
					request,
					resolve: (answer: ScheduleReviewAnswer) => {
						if (settled) return
						settled = true
						signal?.removeEventListener('abort', onAbort)
						// Let the overlay's key dispatch finish before App regains its
						// keyboard handler, so Esc cannot interrupt this same turn.
						queueMicrotask(() => {
							if (scheduleReviewPromptRef.current === entry) setScheduleReviewPrompt(null)
						})
						resolve(answer)
					},
				}
				const onAbort = () => entry.resolve('cancel')
				signal?.addEventListener('abort', onAbort, { once: true })
				setScheduleReviewPrompt(entry)
				announceApproval()
			}),
		[closeLiveReply, announceApproval, setScheduleReviewPrompt],
	)

	/**
	 * Grow this turn's open task block, or open one. The whole plan rides along
	 * so the block shows the checklist as it stood after the operation; a
	 * `null` operation (a `task_list`) refreshes it without naming a change.
	 */
	const writeTaskBlock = useCallback(
		(st: StreamState, operation: TaskOperation | null, checklist: readonly TaskListItem[]) => {
			st.taskBlockKey ??= nextId()
			const key = st.taskBlockKey
			const id = nextId()
			setMessages(
				(prev) =>
					applyTaskOperation(prev, {
						key,
						id,
						operation,
						checklist,
						settled: settledRef.current,
						glyphColor: tokenColor('status.ok'),
					}) as TranscriptMessage[],
			)
		},
		[nextId],
	)

	// Render one agent event onto the transcript. Shared by the local turn loop
	// and the daemon-attach poller, so both paths produce identical output.
	// `st` carries the streaming-assistant bubble id + accumulated text across
	// events within a turn/stream.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const applyEvent = useCallback(
		(event: AgentEvent, st: StreamState) => {
			if (st.learning) observeTurnEvent(st.learning, event)
			// The wait notice lasts until the provider answers with anything else.
			if (event.kind === 'provider-wait') {
				const notice = describeProviderWait(event, scheduleLiveRef.current?.model?.provider)
				providerWaitNoticeRef.current = notice
				setProviderWaitNotice(notice)
				// The failed attempt had already streamed part of a reply and the
				// request starts over: what it showed is void.
				if (event.restart) {
					if (st.releaseTimer) clearTimeout(st.releaseTimer)
					st.releaseTimer = undefined
					st.pending = ''
					st.text = st.text.slice(0, st.messageTextStart ?? st.text.length)
					st.streamedChars = 0
					setTurnTokens(st.reportedOutputTokens ?? 0)
					const abandoned = st.assistantId
					st.assistantId = null
					if (abandoned) setMessages((prev) => prev.filter((m) => m.id !== abandoned))
				}
			} else if (event.kind === 'hook-status') {
				// A hook's own words for what it is doing, on the same line and with
				// the same lifetime: until anything else arrives.
				const hookNotice: ProviderWaitNotice = { what: event.text }
				providerWaitNoticeRef.current = hookNotice
				setProviderWaitNotice(hookNotice)
			} else if (providerWaitNoticeRef.current !== null) {
				providerWaitNoticeRef.current = null
				setProviderWaitNotice(null)
			}
			const plainOptions = () => ({
				debug: debugRequested(),
				...(scheduleLiveRef.current?.model?.model
					? { model: scheduleLiveRef.current.model.model }
					: {}),
			})
			if (event.kind === 'tool-start' && event.toolName === SKILL_TOOL_NAME) {
				conversationLearning().skillUsed = true
			}
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
			// Redrawn at most five times a second: a count that changes on every
			// delta would re-render the live region per token for a figure no
			// one reads at that rate. A provider report always lands.
			// A count held back is drawn when the interval ends, so the last one
			// of a burst is never left unshown while the stream goes quiet.
			const noteTokens = (force = false) => {
				const show = () => {
					turnTokensShownAt.current = Date.now()
					setTurnTokens((st.reportedOutputTokens ?? 0) + Math.ceil((st.streamedChars ?? 0) / 4))
				}
				const wait = 200 - (Date.now() - turnTokensShownAt.current)
				if (force || wait <= 0) {
					if (turnTokensTimer.current) clearTimeout(turnTokensTimer.current)
					turnTokensTimer.current = undefined
					show()
				} else if (!turnTokensTimer.current) {
					turnTokensTimer.current = setTimeout(() => {
						turnTokensTimer.current = undefined
						show()
					}, wait)
				}
			}
			if (event.kind === 'delta' || event.kind === 'reasoning') {
				st.streamedChars = (st.streamedChars ?? 0) + event.text.length
				noteTokens()
			} else if (event.kind === 'usage' && event.outputTokens !== undefined) {
				st.reportedOutputTokens = event.outputTokens
				st.streamedChars = 0
				noteTokens(true)
			}
			if (event.kind !== 'usage' && 'budget' in event && event.budget) {
				const budget = event.budget
				const own = st.lastUsage
				setUsage((previous) => ({
					totalTokens: budget.ownTokens,
					budget,
					cost: {
						...(own?.cost ?? {
							totalCost: 0,
							cacheDiscount: 0,
							unpricedTokens: 0,
						}),
						unpricedTokens:
							(own?.cost.unpricedTokens ?? 0) +
							Math.max(0, budget.ownTokens - (own?.totalTokens ?? 0)),
					},
					...(own && previous?.context ? { context: previous.context } : {}),
				}))
			}
			switch (event.kind) {
				case 'delta': {
					if (
						event.messageId &&
						(st.sourceMessageId !== event.messageId ||
							(event.textPart && st.sourceTextPartId !== event.textPart.id))
					) {
						if (st.sourceMessageId !== undefined) closeAssistant()
						st.sourceMessageId = event.messageId
						st.sourceTextPartId = event.textPart?.id
					}
					setState('thinking')
					if (event.messageId && event.turnId && st.sessionId) {
						lastAssistantMessage.current = {
							messageId: event.messageId,
							sessionId: st.sessionId,
						}
					}
					// The release clock starts with the first character, not with the
					// turn: the wait before the first token is the model's, and
					// counting it would release the opening sentence on arrival.
					st.releasedAt ??= Date.now()
					setThinking(null)
					if (st.messageTextStart === undefined || (st.assistantId === null && !st.pending)) {
						st.messageTextStart = st.text.length
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
						st.releasedAt = Date.now()
					}
					// A block is the preferred unit; a sentence is the fallback for
					// a paragraph that is taking longer than an operator will wait
					// for it. The timer covers the stream going quiet between two
					// deltas, which the clock check alone cannot see.
					if (st.releaseTimer) clearTimeout(st.releaseTimer)
					if (Date.now() - (st.releasedAt ?? 0) >= STREAM_RELEASE_MS) {
						releaseStalled(st)
					}
					st.releaseTimer = setTimeout(() => {
						st.releaseTimer = undefined
						releaseStalled(st)
					}, STREAM_RELEASE_MS)
					break
				}
				case 'tool-start': {
					turnToolCallsRef.current += 1
					closeAssistant()
					// A call that only looks joins the open counted line; any other call ends it.
					if (event.fold)
						readSearchGroup.start(`${event.turnId ?? ''}:${event.toolUseId}`, event.fold)
					else readSearchGroup.close()
					setThinking(null)
					setState('tool')
					const waitingAgent =
						event.toolName === 'wait_for_task' && event.taskId
							? subagentsRef.current.find(
									(agent) =>
										agent.taskId === event.taskId &&
										(event.turnId === undefined || agent.workflowId === event.turnId),
								)
							: undefined
					const tool: RunningTool = {
						...(waitingAgent
							? {
									taskId: waitingAgent.taskId,
									waitingOn: waitingAgent.description,
								}
							: {}),
						id: event.toolUseId,
						...(event.turnId ? { turnId: event.turnId } : {}),
						toolName: event.toolName,
						activity: event.activity,
						...(event.fold ? { fold: event.fold } : {}),
						label: waitingAgent
							? `Waiting · ${waitingAgent.description}`
							: event.web
								? webCallTitle(event.web)
								: formatToolCall(event.toolName, event.summary, event.standalone),
						startedAt: Date.now(),
						detail: event.detail,
						...(event.command ? { command: event.command } : {}),
						...(event.proposed ? { proposed: event.proposed } : {}),
						...(event.web ? { web: event.web, progress: webLiveStatus(event.web) } : {}),
					}
					// A call that was asked about already has its row (waiting, or running
					// once it was approved): the start takes it over, in the place it holds.
					activeToolsRef.current = withTakenOverRow(activeToolsRef.current, tool)
					setActiveTools(activeToolsRef.current)
					break
				}
				case 'tool-progress': {
					const running = activeToolsRef.current
					const index = running.findIndex(
						(tool) =>
							tool.id === event.toolUseId &&
							(event.turnId === undefined || tool.turnId === event.turnId),
					)
					// A terminal event may already have removed this call. Never recreate
					// a live row from late diagnostic state.
					if (index < 0) break
					const current = running[index] as RunningTool
					const { fraction: _fraction, ...withoutFraction } = current
					const updated: RunningTool = {
						...withoutFraction,
						progress: event.message,
						...(current.command !== undefined
							? {
									tail: [...(current.tail ?? []), event.message].slice(-SHELL_LIVE_LINES),
								}
							: {}),
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
					// A background bash call or a monitor creates its job before this
					// event. A job action may also stop one. Re-read the owning session
					// here so the footer and rail update while the model continues.
					if (
						event.toolName === 'bash' ||
						event.toolName === 'job' ||
						event.toolName === MONITOR_TOOL_NAME
					)
						setJobSnapshot({
							ownerSession: previousSessionRef.current,
							jobs: previousSessionRef.current?.jobs?.() ?? [],
						})
					const running = activeToolsRef.current
					// Match strictly by toolUseId. Never fall back to "the first
					// active tool" — under parallel calls that mis-attributes a
					// result to the wrong call. If no id matches, render the
					// completion on its own (label from the end event itself).
					const i = running.findIndex(
						(tool) =>
							tool.id === event.toolUseId &&
							(event.turnId === undefined || tool.turnId === event.turnId),
					)
					const done = i >= 0 ? running[i] : undefined
					if (i >= 0) {
						activeToolsRef.current = [...running.slice(0, i), ...running.slice(i + 1)]
						setActiveTools(activeToolsRef.current)
					}
					// Lifecycle updates own completion rows, even when the model never waits.
					// Keep unknown waits and errors visible; never hide an unrepresented task.
					const inspectableWait =
						done?.taskId &&
						subagentsRef.current.some(
							(agent) =>
								agent.taskId === done.taskId &&
								(event.turnId === undefined || agent.workflowId === event.turnId) &&
								agent.transcript.some(
									(row) => row.kind === 'assistant' && row.text.trim().length > 0,
								),
						)
					if (!event.isError && inspectableWait && event.toolName === 'wait_for_task') {
						setState(activeToolsRef.current.length > 0 ? 'tool' : 'thinking')
						break
					}
					const representedSuccessfulAgent =
						!event.isError &&
						event.toolName.toLowerCase() === 'agent' &&
						subagentsRef.current.some(
							(agent) =>
								agent.toolUseId === event.toolUseId &&
								(event.turnId === undefined || agent.workflowId === event.turnId),
						)
					// The band above the rail already carries a narrated line, in the
					// parent's own words, from the moment it is written. Printing the
					// call that wrote it would show the same sentence twice, the
					// second time as protocol — the same duplicate-protocol case as
					// the represented Agent call just below, and refused the same
					// way. A REFUSED line keeps its row: nothing reached the screen,
					// and that row is the only thing that says so.
					if (!event.isError && event.toolName === NARRATION_TOOL_NAME) {
						setState(activeToolsRef.current.length > 0 ? 'tool' : 'thinking')
						break
					}
					if (representedSuccessfulAgent) {
						// The automatic panel already owned this successful child from
						// start through settlement. Re-emitting its internal Agent call as
						// a transcript tool row after the panel closes is duplicate protocol,
						// not useful history. Failures remain durable transcript rows.
						setState(activeToolsRef.current.length > 0 ? 'tool' : 'thinking')
						break
					}
					const built = toolEndRows(event, done, {
						...(done ? { elapsedMs: Date.now() - done.startedAt } : {}),
						hasPlan: tasksRef.current.length > 0,
						cwd: ctxRef.current.cwd,
					})
					if (built.kind === 'task-block') {
						writeTaskBlock(st, null, tasksRef.current)
					} else if (built.kind === 'rows') {
						const only = built.rows.length === 1 ? built.rows[0] : undefined
						// A look that succeeded is kept in the open counted line; anything
						// else (a failure, a refusal, a call whose line is already settled)
						// is a row of its own, which also ends the line.
						const kept =
							only?.group !== undefined &&
							readSearchGroup.finish(`${event.turnId ?? ''}:${event.toolUseId}`, only.detail ?? [])
						if (!kept) for (const row of built.rows) pushRow(row)
					}
					setState(activeToolsRef.current.length > 0 ? 'tool' : 'thinking')
					break
				}
				case 'usage':
					// The model's response is over (the kernel reports its spend after the
					// last delta): commit what it wrote now. Left open until the turn
					// settles, the tail of a reply stays held back for as long as the turn
					// waits on background agents, and their notices print above it.
					closeAssistant()
					st.lastUsage = event
					// What the cache and context look like after this call; the idle
					// compactor decides from it when the turn is over.
					idleCompaction.compactor.recordCall(event.cache)
					idleCompaction.contextTokens.current = event.contextTokens
					setUsage({
						totalTokens: event.totalTokens,
						...(event.budget ? { budget: event.budget } : {}),
						cost: event.cost,
						...(event.contextTokens !== undefined && event.contextWindowTokens !== undefined
							? {
									context: {
										tokens: event.contextTokens,
										windowTokens: event.contextWindowTokens,
										measured: event.contextMeasuredBy === 'provider',
										windowAssumed:
											event.windowSource !== 'provider' && event.windowSource !== 'config',
										...(event.windowSource ? { windowSource: event.windowSource } : {}),
									},
								}
							: {}),
					})
					break
				case 'reasoning': {
					if (event.done) break
					thinkingForNextRowRef.current += event.text
					setState('thinking')
					// The last line only, bounded: a screen-wide row that changes as
					// the model writes is a spinner with words, not a transcript.
					setThinking((prev) => {
						const joined = `${prev ?? ''}${event.text}`
						const lastLine = joined.slice(joined.lastIndexOf('\n') + 1)
						return lastLine.length > 160 ? `…${lastLine.slice(-159)}` : lastLine
					})
					break
				}
				case 'task': {
					// The transcript owns the checklist: consecutive operations fold
					// into one block there (task-activity.ts). The live row above the
					// composer only names the current step.
					const item: TaskListItem = {
						id: event.taskId,
						subject: event.subject,
						status: event.status,
						...(event.blockedBy
							? { blockedBy: event.blockedBy }
							: (() => {
									const known = tasksRef.current.find((task) => task.id === event.taskId)?.blockedBy
									return known ? { blockedBy: known } : {}
								})()),
					}
					// A reply in progress ends here, as it does at a tool call, so
					// the block lands after the text that led to it.
					closeAssistant()
					let operation: TaskOperation | null
					if (event.removed) {
						// Removed from the plan: it leaves the checklist, and the block
						// says so, rather than drawing it as still open.
						const next = removeTask(tasksRef.current, item.id, item.subject)
						operation = next.operation
						tasksRef.current = next.tasks
					} else {
						const previous = tasksRef.current.find((task) => task.id === item.id)
						operation = taskOperationFor(previous, item)
						tasksRef.current = upsertTask(tasksRef.current, item)
					}
					const checklist = tasksRef.current
					setTasks(checklist)
					if (operation) writeTaskBlock(st, operation, checklist)
					break
				}
				case 'job':
					// The session listener normally painted this at exit time. A host
					// without that listener still gets the kernel event; never paint twice.
					if (!idleJobNoticesRef.current.shown.has(event.jobId)) {
						idleJobNoticesRef.current.shown.add(event.jobId)
						const row = jobExitRow(event)
						pushMessage('system', row.text, false, '●', undefined, row.color, row.meta)
					}
					break
				case 'context':
					// Into the TRANSCRIPT, not a status line. A status indicator is
					// present while nothing is happening and gone afterwards, so
					// someone reading back could not tell whether the gap they are
					// looking at was compacted. The event is a fact about the
					// conversation and belongs in its record.
					// Tool-result clearing is tallied for /context and never drawn;
					// the summary that follows a clearing pass that was not enough
					// shows as a live "Compacting conversation…" line meanwhile.
					setSummarising(event.compacting === true)
					if (event.row === 'compacted') {
						setContextHidden(true)
						pushMessage(
							'system',
							event.text,
							false,
							CLOSING_GLYPH,
							event.detail,
							tokenColor('text.muted'),
							COMPACTED_HINT,
							'summary',
						)
					} else if (event.row !== 'hidden') {
						pushSystem(event.row === 'warning' ? 'warning' : 'notice', event.text)
					}
					if (event.shed) {
						setCompactionTally((tally) => ({
							passes: tally.passes + 1,
							clearedResults: tally.clearedResults + (event.cleared ?? 0),
							stubbedNarrations: tally.stubbedNarrations + (event.stubbed ?? 0),
							summaries: tally.summaries + (event.summarised ? 1 : 0),
							reclaimedTokens: tally.reclaimedTokens + (event.reclaimedTokens ?? 0),
						}))
					}
					break
				case 'hook-notice':
					pushSystem(event.halted ? 'warning' : 'notice', event.text)
					break
				case 'provider-fallback':
					// The transcript, for the reason compaction is in the transcript
					// and one stronger: a status line is gone the moment the next
					// thing happens, and someone reading back a session needs to know
					// which answers came from the provider they picked and which did
					// not. A swap is a permanent fact about this turn.
					pushSystem('warning', event.text)
					break
				case 'capability-warning':
					pushSystem(
						'warning',
						withDebugDetail(
							describeCapabilityNotice({
								capability: event.capability,
								...(event.contentSource ? { contentSource: event.contentSource } : {}),
								providerId: event.providerId,
							}),
							event.text,
							debugRequested(),
						),
					)
					break
				case 'history-repair':
					pushSystem(
						'notice',
						withDebugDetail(
							describeHistoryRepairNotice({
								source: event.source,
								duplicateResults: event.duplicateResults,
								orphanedResults: event.orphanedResults,
								interruptedCalls: event.interruptedCalls,
								...(event.rejectedImages !== undefined
									? { rejectedImages: event.rejectedImages }
									: {}),
								...(scheduleLiveRef.current?.model?.provider
									? { providerId: scheduleLiveRef.current.model.provider }
									: {}),
							}),
							event.text,
							debugRequested(),
						),
					)
					break
				case 'done': {
					setSummarising(false)
					// Persistence and memory use the settled answer, not concatenated
					// commentary deltas. The transcript keeps each visible part above.
					if (event.text !== undefined) st.text = event.text
					// `turn_completed` is not synonymous with success: budgets,
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
					// A plain No stopped this turn: say so once, under the calls it left.
					if (refusalEndedTurnRef.current) {
						refusalEndedTurnRef.current = false
						if (event.stopReason === 'cancelled') {
							const row = interruptionRow({ callRunning: false })
							pushMessage('system', row.content, false, row.glyph, undefined, row.color)
						}
					}
					const stopNotice = describeTurnStop(event.stopReason, event.budget)
					if (stopNotice) pushSystem('warning', stopNotice)
					if (st.startedAt !== undefined) {
						const since = st.startedAt
						const delegated = subagentsRef.current.filter(
							(agent) =>
								agent.replayed !== true && !isWorkflowRunAgent(agent) && agent.startedAt >= since,
						)
						// A turn that delegated always says what its agents came to; one
						// that did not closes with its time only when it finished, since
						// a stop or a cancellation has already said how it ended.
						const pausedMs = pauseClockRef.current.total(Date.now()) - (st.pausedAtStart ?? 0)
						// Background agents still running: the turn is over, its closing line
						// waits for them (`Waiting for N background agents to finish` until
						// they end), and counts the wait.
						if (
							pendingBackgroundAgents(delegated, isWorkflowRunAgent).length > 0 &&
							(st.completed || st.outcome === 'completed')
						) {
							const earlier = closingWaitRef.current
							closingWaitRef.current = {
								since: earlier?.since ?? since,
								pausedMs: (earlier?.pausedMs ?? 0) + pausedMs,
								lastEndedAt: Date.now(),
							}
							setClosingWaitVersion((version) => version + 1)
						}
						const closing =
							closingWaitRef.current === null && (delegated.length > 0 || st.completed)
								? settleLine(Date.now() - since - pausedMs, delegated, new Date())
								: undefined
						// The workflows this turn ran are over: each says how it ended once.
						for (const agent of delegated) endedWorkflowTurnsRef.current.add(agent.workflowId)
						flushWorkflowNotices()
						if (closing)
							pushMessage(
								'system',
								closing,
								false,
								CLOSING_GLYPH,
								undefined,
								tokenColor('text.muted'),
							)
					}
					// A save the operator asked for in words takes the place of
					// the proposal to save it.
					if (!triggerFollowUpsRef.current?.(st, st.completed ? 'completed' : 'stopped'))
						offerSkillSuggestion(st)
					break
				}
				case 'paused':
					setSummarising(false)
					// Paused is a recoverable SDK verdict, not success and not failure.
					// Conversation evidence has no paused member, so it records the
					// truthful coarse outcome (`stopped`) while queue copy retains the
					// distinction the operator acts on.
					closeAssistant()
					st.outcome = 'stopped'
					st.queuePauseOutcome = 'paused'
					st.notification = { kind: 'turn-settled', outcome: 'stopped' }
					triggerFollowUpsRef.current?.(st, 'paused')
					if (event.handoff) {
						// Nothing failed and nothing needs approving: a tool needs the
						// operator to do something first. Continuing is one key.
						const browser = browserControlRef.current
						const browserStatus = browser?.status()
						const browserNotice = describeBrowserHandoff(event.handoff, browserStatus)
						// Without a window the sign-in happens in `namzu browser
						// login`, which needs the profile this session holds.
						if (browserNotice && browser && browserStatus?.headless) void browser.release()
						pushSystem('warning', browserNotice ?? describePlainInterruption(event, plainOptions()))
						setHandoffPark({
							turnId: event.turnId,
							reason: event.handoff.reason,
						})
					} else {
						pushSystem('warning', describePlainInterruption(event, plainOptions()))
						// Enter on an empty composer continues it, like a tool's pause;
						// typing a new message moves on and /resume stays available.
						setHandoffPark({ turnId: event.turnId })
					}
					break
				case 'error':
					setSummarising(false)
					closeAssistant()
					st.outcome = event.message === 'aborted' ? 'cancelled' : 'failed'
					triggerFollowUpsRef.current?.(st, st.outcome)
					if (event.message !== 'aborted') {
						st.notification = { kind: 'turn-settled', outcome: 'failed' }
						pushSystem('error', describePlainInterruption(event, plainOptions()))
					} else st.notification = null
					break
			}
		},
		[
			appendToMessage,
			conversationLearning,
			finalizeMessage,
			flushStream,
			offerSkillSuggestion,
			pushMessage,
			setHandoffPark,
			writeTaskBlock,
		],
	)
	applyEventRef.current = applyEvent

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const runTurn = useCallback(
		async (prompt: QueuedPrompt) => {
			// A passive queue effect can still hold the previous render's session
			// while a replacement is being committed. Keep FIFO ownership until
			// the render and the resource-owning session agree.
			const pendingAtAdmission = pendingModelSwitchRef.current
			if (pendingAtAdmission || previousSessionRef.current !== session) {
				replaceQueued([prompt, ...queuedRef.current])
				return
			}
			if (!session || !session.hasProvider) {
				pushMessage('system', session?.errorHint ?? 'Agent is not ready yet — give it a moment.')
				return
			}
			if (prompt.kind === 'peer' && prompt.generation !== conversationGenRef.current) {
				pushMessage('system', 'Peer message was not delivered because the conversation changed.')
				return
			}
			if (prompt.kind === 'notice' && prompt.generation !== conversationGenRef.current) return
			setContextHidden(false)
			const { text: promptText } = prompt
			let text = promptText
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
			// Both awaits below can span an interrupt, a `/clear` or a `/resume`,
			// and neither has an abort controller yet for them to cancel. The
			// token is what they take back instead.
			const admission = {}
			admissionRef.current = admission
			let durableScope: SessionScope | undefined
			try {
				durableScope = await materializeConversation()
			} catch (error) {
				pushSystem(
					'error',
					explainFailure(
						error,
						'This conversation could not be saved. It will continue, but it cannot be resumed later.',
					),
				)
			}
			// A conversation can be closed outside this App after it was opened or
			// resumed. Re-check at the actual turn boundary, before expanding file
			// mentions, recording run evidence, or creating a provider iterator.
			// The persistence helpers repeat the same check at their own boundary;
			// neither read is claimed to serialize a concurrent archive (that needs
			// a store-level lease shared with ProjectManager).
			const destination = conversationMaterializedRef.current
				? (durableScope?.sessionId ?? scopeRef.current?.sessionId ?? null)
				: null
			const turnSessions = sessionsRef.current
			if (turnSessions && destination) {
				try {
					await requireWritableConversation(turnSessions, destination, 'start conversation turn')
				} catch (err) {
					// Taken back meanwhile: the slot is no longer this prompt's.
					if (admissionRef.current !== admission) return
					admissionRef.current = null
					if (prompt.kind === 'goal' && prompt.goalRound) {
						goalActivation.disarm(prompt.goalRound.sessionId, prompt.goalRound)
						wakeGoalDriver()
					}
					pushSystem('error', explainFailure(err, 'Your message was not sent.'))
					setState('idle')
					return
				}
			}
			// Interrupted, or the conversation changed, while this prompt waited at
			// the boundary. Whoever took the slot back already freed it and said
			// so, and a turn of the new conversation may hold it now; this prompt
			// is dropped rather than begun under that conversation.
			if (admissionRef.current !== admission) return
			admissionRef.current = null
			if (
				prompt.kind === 'peer' &&
				!peersRef.current?.takeExact(prompt.generation, prompt.mail.id)
			) {
				setState('idle')
				return
			}
			// What ended is taken now, at admission, so a turn that was already
			// running has had its chance to take it first and nothing is said twice.
			let noticeKind: RuntimeContextMessageKind = 'task-completion'
			if (prompt.kind === 'notice') {
				const ended = [...workflowNoticesRef.current.values(), ...childMessagesRef.current.values()]
				workflowNoticesRef.current.clear()
				childMessagesRef.current.clear()
				const jobs = idleJobNoticesRef.current
				const jobLines =
					jobs.ownerSession === session
						? [...jobs.pending].filter(([id]) => wakeJobIdsRef.current.has(id))
						: []
				for (const [id] of jobLines) {
					jobs.delivered.add(id)
					jobs.pending.delete(id)
					wakeJobIdsRef.current.delete(id)
				}
				// What monitors said is taken now, like the rest: an event the kernel
				// already put in front of the model during a turn was acknowledged
				// and is not here.
				const monitorNotice = session?.monitors?.take()
				if (ended.length === 0 && jobLines.length === 0 && !monitorNotice?.text) {
					setState('idle')
					return
				}
				if (ended.length === 0) noticeKind = 'job-exit'
				text = [
					...ended,
					...(monitorNotice?.text ? [monitorNotice.text] : []),
					...(jobLines.length > 0
						? [`Background jobs that ended:\n${jobLines.map(([, line]) => `- ${line}`).join('\n')}`]
						: []),
				].join('\n\n')
			}
			// `@path` mentions: the visible human message keeps the readable token,
			// but the model receives the file contents inlined. An automatic goal
			// prompt is already host-authored context and is never reinterpreted as
			// a file-mention command.
			const expanded =
				prompt.kind === 'human'
					? expandFileMentions(text, ctx.cwd)
					: { sendText: text, attached: [] as readonly string[] }
			const { sendText, attached, inlined } = expanded
			const historyBeforeTurn = modelHistoryRef.current
			// File contents are not the operator's words. They travel as their own
			// message, marked as host-supplied, so nothing that reads "what the
			// person said" (the auto-mode classifier above all) reads a file as
			// the person's instruction.
			const fileMessage =
				inlined !== undefined
					? createUserMessage(inlined, undefined, {
							type: 'runtime-context',
							kind: 'host-observation',
						})
					: undefined
			const userMessage = createUserMessage(
				fileMessage ? text : sendText,
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
					: prompt.kind === 'peer'
						? { type: 'runtime-context', kind: 'peer-message' }
						: prompt.kind === 'notice'
							? { type: 'runtime-context', kind: noticeKind }
							: undefined,
			)
			const priorForSdk: Message[] = [
				...historyBeforeTurn,
				userMessage,
				...(fileMessage ? [fileMessage] : []),
			]
			const closeStoppedReply = async (): Promise<void> => {
				const sessions = sessionsRef.current
				const scope = scopeRef.current
				if (!sessions || !scope || !conversationMaterializedRef.current || !session?.abandonTurn)
					return
				const stopped = await closableProviderPause(sessions, scope.sessionId)
				if (!stopped) return
				// Its unknown usage stays on the ledger; the failed message stays in
				// what the provider is shown, as in the desktop app.
				await session.abandonTurn(
					stopped.turnId as TurnId,
					'The operator went on with a new message instead of retrying.',
				)
				setHandoffPark(null)
			}
			// Reserved before the turn begins, so everything that refers to this
			// turn — its goal-round authority above all — names it from the start.
			const turnId = generateTurnId()
			// The composer triggers the operator armed for this message, checked
			// again now: the mode or the session may have changed while it waited
			// in the queue. None of them changes the operator's words.
			const requestedTriggers = prompt.kind === 'human' ? (prompt.triggers ?? []) : []
			const triggerContext = triggerContextNow()
			const turnTriggers = requestedTriggers.filter(
				(id) => triggerUnavailable(id, triggerContext) === undefined,
			)
			const pinnedEffort = triggerEffort(turnTriggers, session.reasoningEffortLevels)

			if (prompt.kind === 'peer') {
				pushSystem('notice', peerMailLabel(prompt.mail))
			} else if (prompt.kind === 'notice') {
				// The closing line for what ended is already in the conversation; the
				// model's report is what follows it. Nothing is added here.
			} else if (goalRound) {
				pushSystem('notice', goalRoundHeadline(goalRound.round, goalRound.maxGoalRounds), {
					continuation: goalRound.objective,
				})
			} else {
				pushMessage(
					'user',
					// What the operator typed: a command that composes the model's
					// message shows the command, not the rewrite.
					prompt.kind === 'human' ? (prompt.recallText ?? text) : text,
					false,
					undefined,
					undefined,
					undefined,
					humanPromptMeta(attached.length, attachments),
				)
				const tagLine = transcriptTagLine(turnTriggers, {
					effort: pinnedEffort,
					steered: false,
				})
				if (tagLine) pushSystem('notice', tagLine)
				for (const id of requestedTriggers) {
					const reason = triggerUnavailable(id, triggerContext)
					if (reason) pushSystem('notice', notAppliedLine([triggerDefinition(id).label], reason))
				}
			}
			// A plan is scoped to the request it was made for. Cleared here, at
			// the start of the next one, rather than when the previous turn
			// ended: a finished list stays on screen until the operator moves on,
			// which is the moment it has told them everything it can.
			setTasks([])
			tasksRef.current = []
			// The model interleaves text → tool → text across iterations; `applyEvent`
			// renders each one in order.
			if (turnTokensTimer.current) clearTimeout(turnTokensTimer.current)
			turnTokensTimer.current = undefined
			setTurnTokens(0)
			turnTokensShownAt.current = 0
			thinkingForNextRowRef.current = ''
			const st: StreamState = {
				assistantId: null,
				startedAt: Date.now(),
				pausedAtStart: pauseClockRef.current.total(Date.now()),
				text: '',
				conversationMessages: undefined,
				pending: '',
				completed: false,
				outcome: null,
				sessionId: destination,
				notification: null,
				...(prompt.kind === 'human'
					? {
							learning: createTurnActivity(),
							...(prompt.skillFlow ? { skillFlow: true } : {}),
							startedInPlanMode: permissionModeRef.current === 'plan',
						}
					: {}),
				followUps: turnTriggers.filter((id) => triggerDefinition(id).scope === 'after-turn'),
				contextTexts: triggerContextTexts(turnTriggers),
			}
			liveStreamRef.current = st
			// A skill activated with /skills <name> stays in the prompt of every
			// later conversation too; a turn run under one already used a skill.
			if (st.learning && activeSkills.length > 0) st.learning.skillUsed = true
			const ac = new AbortController()
			const turnToken = {}
			let abnormalTerminal:
				| {
						token: object
						continuationEpoch: number
						outcome: QueuePauseOutcome
				  }
				| undefined
			const markNonGoalAbnormal = () => {
				if (
					prompt.kind === 'goal' ||
					abnormalTerminal !== undefined ||
					(st.outcome !== 'failed' && st.outcome !== 'stopped')
				)
					return
				abnormalTerminal = {
					token: turnToken,
					continuationEpoch: queueContinuationEpochRef.current,
					outcome: st.queuePauseOutcome ?? st.outcome,
				}
			}
			abortRef.current = ac
			refusalEndedTurnRef.current = false
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
			const requestModelSwitch = async (
				request: ModelSwitchRequest,
				requestSignal?: AbortSignal,
			): Promise<ModelSwitchOutcome> => {
				if (
					!currentProvider ||
					!stillHere() ||
					ac.signal.aborted ||
					requestSignal?.aborted ||
					appLifetime.signal.aborted ||
					activeTurnTokenRef.current !== turnToken ||
					previousSessionRef.current !== session
				) {
					return {
						kind: 'rejected',
						reason: 'The requesting turn is no longer active.',
					}
				}
				const accepted = pendingModelSwitchRef.current
				if (
					accepted?.turnToken === turnToken &&
					!accepted.signal.aborted &&
					accepted.selection?.model === request.model.trim() &&
					(!request.provider || accepted.selection.id === request.provider.trim())
				) {
					return { kind: 'pending', selection: accepted.selection }
				}
				// A later request supersedes an earlier lookup even if its model list
				// resolves first. Cancellation never changes the active provider.
				cancelPendingModelSwitch()
				const controller = new AbortController()
				const pending: PendingModelSwitch = {
					turnToken,
					generation: turnGeneration,
					sessionId: scopeRef.current?.sessionId,
					ownerSession: session,
					controller,
					// A tool's lifetime can end before the turn. Once accepted, the
					// switch belongs to the turn and host, not that completed tool call.
					signal: AbortSignal.any([ac.signal, appLifetime.signal, controller.signal]),
				}
				pendingModelSwitchRef.current = pending
				setModelSwitchVersion((version) => version + 1)
				try {
					const result = await resolveModelSwitch(request, {
						currentProvider,
						detected,
						describeModels: describeProviderModels,
						signal: requestSignal
							? AbortSignal.any([pending.signal, requestSignal])
							: pending.signal,
					})
					if (
						pendingModelSwitchRef.current !== pending ||
						pending.signal.aborted ||
						requestSignal?.aborted ||
						!stillHere() ||
						activeTurnTokenRef.current !== turnToken
					) {
						return {
							kind: 'rejected',
							reason: 'The model switch was cancelled or superseded.',
						}
					}
					if (result.kind === 'rejected') return result
					pending.selection = result.selection
					return { kind: 'pending', selection: result.selection }
				} catch (error) {
					return {
						kind: 'rejected',
						reason: pending.signal.aborted
							? 'The model switch was cancelled.'
							: explainFailure(error, 'Could not resolve the requested model.'),
					}
				} finally {
					if (!pending.selection && pendingModelSwitchRef.current === pending) {
						cancelPendingModelSwitch()
					}
				}
			}
			let inboxOpen = true
			const inboxEntries: LiveInput[] = []
			const inputWaiters = new Set<() => void>()
			const inbox: ActiveTurnInbox = {
				notify() {
					for (const wake of [...inputWaiters]) wake()
				},
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
					for (const wake of [...inputWaiters]) wake()
					return true
				},
				waitForInbound(signal): Promise<void> {
					if (signal.aborted) return Promise.reject(signal.reason)
					if (
						!inboxOpen ||
						inboxEntries.length > 0 ||
						[...directChildNoticesRef.current.keys()].some((id) => !childNoticeSnapshot.has(id)) ||
						(peersRef.current?.enabled && peersRef.current.pending > 0)
					)
						return Promise.resolve()
					return new Promise((resolve, reject) => {
						const cleanup = () => {
							inputWaiters.delete(wake)
							signal.removeEventListener('abort', abort)
						}
						const wake = () => {
							cleanup()
							resolve()
						}
						const abort = () => {
							cleanup()
							reject(signal.reason)
						}
						inputWaiters.add(wake)
						signal.addEventListener('abort', abort, { once: true })
					})
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
								input.prompt.recallText ?? input.prompt.text,
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
					for (const wake of [...inputWaiters]) wake()
					return inboxEntries.splice(0, inboxEntries.length)
				},
			}
			activeTurnInboxRef.current = inbox
			// Materialization mutates a ref without a render. Publish after its
			// admission barrier so discovery cannot retain the transient refusal.
			peersRef.current?.publish()
			const turnPermissionMode = permissionModeRef.current
			const workflowGeneration = conversationGenRef.current
			const workflowSessionId = scopeRef.current?.sessionId
			const workflowOwns = (): boolean =>
				!appLifetime.signal.aborted &&
				previousSessionRef.current === session &&
				conversationGenRef.current === workflowGeneration &&
				scopeRef.current?.sessionId === workflowSessionId
			const turnReasoningEffort = reasoningEffortRef.current
			const turnHypermode = hypermodeRef.current
			const turnLimits = resolveTurnGuards(ctxRef.current.limits, turnLimitsOverrideRef.current)
			// Always carry the guarded callback. `auto` and `strict` decide before
			// calling it in makeResumeHandler; retaining it is what lets a session
			// launched with --yolo later return to prompt mode truthfully.
			//
			// A background agent this turn launched outlives it and keeps asking
			// through this same callback, so a turn that has merely ended (or been
			// followed by another) still answers: only a stopped turn, another
			// conversation or a closing app refuse.
			const askPermission = async (req: PermissionRequest): Promise<PermissionDecision> => {
				if (!stillHere() || ac.signal.aborted || appLifetime.signal.aborted) {
					return { kind: 'reject', feedback: 'Turn is no longer active.' }
				}
				const decision = await onPermission(req)
				// An agent can ask after its turn has ended. Answering puts the screen
				// in the working state for the resumed provider call, and no turn is
				// left whose end would put the input back: with none running, hand the
				// conversation back so the agent's finish can wake it.
				if (
					stillHere() &&
					!appLifetime.signal.aborted &&
					activeTurnTokenRef.current === null &&
					!abortRef.current &&
					!permissionResolveRef.current
				) {
					setState('idle')
				}
				return decision
			}
			// A goal round is a turn of a durable conversation: its round is recorded
			// on the turn (`origin.kind: 'goal-round'`), and a conversation that is
			// not in a log has nowhere to record it.
			const admitted = goalRound === undefined || Boolean(turnSessions && destination)
			if (!admitted && goalRound) {
				goalActivation.disarm(goalRound.sessionId, goalRound)
				wakeGoalDriver()
				pushMessage(
					'system',
					`Goal round ${goalRound.round} was not started because this conversation is not durable. Automatic continuation is disarmed; /goal resume retries explicitly.`,
				)
			}
			let idleNoticeSnapshot: {
				readonly ids: readonly string[]
				readonly text?: string
			} = {
				ids: [],
			}
			let monitorSnapshot: {
				readonly ids: readonly string[]
				readonly text?: string
			} = {
				ids: [],
			}
			let childNoticeSnapshot = new Map<number, DirectChildNotice>()
			let workflowNoticeSnapshot = new Map<string, string>()
			let childMessageSnapshot = new Map<number, string>()
			try {
				// Setup above awaited. A conversation switch can happen meanwhile and
				// move the mutable SessionScope captured by `createAgentSession`. Re-admit
				// the turn here, immediately before the generator exists, or an
				// abandoned prompt can begin its reserved turn under the new
				// conversation.
				if (
					admitted &&
					!ac.signal.aborted &&
					stillHere() &&
					activeTurnTokenRef.current === turnToken &&
					(!goalRound ||
						(destination === goalRound.sessionId &&
							goalActivation.isArmed(goalRound.sessionId, goalRound)))
				) {
					// Keep these notices pending until a completed send commits them.
					// An early throw or abort never proves the model received context.
					idleNoticeSnapshot = snapshotIdleJobNotices()
					monitorSnapshot = snapshotMonitorNotices()
					childNoticeSnapshot = new Map(directChildNoticesRef.current)
					workflowNoticeSnapshot = new Map(workflowNoticesRef.current)
					childMessageSnapshot = new Map(childMessagesRef.current)
					const operatorShellSnapshot = drainOperatorShell()
					// "Press Enter to try again, or type a new message": a reply that
					// stopped on a provider failure waits for no person, so the new
					// message closes it and runs on the model chosen now, whichever
					// model began it. A pause that waits for a decision or a handoff
					// is left alone and still refuses the message.
					await closeStoppedReply()
					if (prompt.kind === 'human' && destination) {
						recapTurnRef.current = { sessionId: destination, turnId }
						startGeneratedTitle(session.sideModel, destination, turnId, promptText)
					}
					const typedInput = typedInputOf(prompt)
					const sendOnce = (prior: readonly Message[]) =>
						session.send(prior, {
							signal: ac.signal,
							turnId,
							origin: {
								protocol: 'cli',
								kind: goalRound ? 'goal-round' : 'prompt',
							},
							// Only the person's own words can set a token target.
							...(typedInput !== undefined ? { typedInput } : {}),
							// The TUI never resumes a turn whose process is gone; the next
							// prompt closes it. A paused turn is never closed this way.
							abandonInterrupted: true,
							// A redrawing screen can take back a reply a dropped connection cut short.
							restartableOutput: true,
							permissionMode: turnPermissionMode,
							// Read at every decision: the operator may change the mode
							// while this turn runs, and the change governs what follows.
							currentPermissionMode: () => permissionModeRef.current,
							onAutoModeLimit: handleAutoModeLimit,
							limits: turnLimits,
							// A trigger that pins the highest effort does so for this
							// turn only; the session's own setting is untouched.
							...((pinnedEffort ?? turnReasoningEffort) !== undefined
								? { effort: pinnedEffort ?? turnReasoningEffort }
								: {}),
							...(turnHypermode ? { hypermode: true } : {}),
							...(turnTriggers.includes('workflow') ? { workflow: true } : {}),
							// Read at every iteration, so an after-turn trigger a steer
							// binds to this turn is said from the next one on.
							hostContext: () =>
								[
									...(st.contextTexts ?? []),
									idleNoticeSnapshot.text,
									monitorSnapshot.text,
									workflowNoticeSnapshot.size > 0
										? `Workflows that ended since your last turn:\n\n${[...workflowNoticeSnapshot.values()].join('\n\n')}`
										: undefined,
									operatorShellSnapshot,
									...[...childNoticeSnapshot.values()].map((notice) => notice.context),
									...childMessageSnapshot.values(),
								].filter((part): part is string => Boolean(part)),
							...(goalRound ? { goalRound } : {}),
							// The mode above decides whether this callback is consulted.
							onPermission: askPermission,
							// The terminal asks about one call at a time while the batch runs.
							...(perCallReviewRef.current
								? { perCallReview: perCallReviewRef.current.config }
								: {}),
							// A workflow this turn starts outlives it, so its agents cannot borrow
							// `askPermission`, which belongs to this turn. They ask through the
							// conversation instead, for as long as it is the one on screen.
							workflowReview: {
								onPermission: async (request) => {
									if (!workflowOwns()) {
										return {
											kind: 'reject',
											feedback: 'The owning conversation changed.',
										}
									}
									const decision = await onPermission(request)
									// An agent can ask while no turn runs; nothing else would put the
									// input back once the operator has answered.
									if (workflowOwns() && !abortRef.current && !permissionResolveRef.current) {
										setState('idle')
									}
									return decision
								},
								currentPermissionMode: () => permissionModeRef.current,
							},
							onQuestion: askQuestion,
							onPlanExit: askPlanApproval,
							bypassAvailable: () => bypassAvailableRef.current,
							onModelSwitch: requestModelSwitch,
							inboundMessages: () => {
								const operatorMessages = inbox.drain()
								if (ac.signal.aborted || !stillHere()) return operatorMessages
								const mail = peersRef.current?.take(turnGeneration) ?? []
								const childNotices = [...directChildNoticesRef.current].filter(
									([id]) => !childNoticeSnapshot.has(id),
								)
								// A workflow that ended while this turn runs: told to the model once.
								const workflowEnds = [...workflowNoticesRef.current].filter(
									([id]) => !workflowNoticeSnapshot.has(id),
								)
								for (const [id] of workflowEnds) workflowNoticesRef.current.delete(id)
								// What a running agent said to the conversation: told to the model once.
								const childMessages = [...childMessagesRef.current].filter(
									([id]) => !childMessageSnapshot.has(id),
								)
								for (const [id] of childMessages) childMessagesRef.current.delete(id)
								if (childNotices.length) {
									flushStream(st)
									if (st.assistantId) {
										finalizeMessage(st.assistantId)
										st.assistantId = null
									}
									// What the person typed to an agent is in that agent's transcript, so
									// main prints nothing for it; the model still gets the note.
									for (const [id] of childNotices) directChildNoticesRef.current.delete(id)
								}
								if (mail.length) {
									// An idle wake may already be queued behind operator admission.
									// Once this turn drains it, its queue row is no longer pending.
									const deliveredIds = new Set(mail.map((item) => item.id))
									replaceQueued(
										queuedRef.current.filter(
											(item) => item.kind !== 'peer' || !deliveredIds.has(item.mail.id),
										),
									)
									flushStream(st)
									if (st.assistantId) {
										finalizeMessage(st.assistantId)
										st.assistantId = null
									}
									for (const item of mail) pushSystem('notice', peerMailLabel(item))
								}
								return [
									...operatorMessages,
									...mail.map(peerMailMessage),
									...childNotices.map(([, notice]) =>
										createRuntimeContextMessage(notice.context, notice.kind),
									),
									...workflowEnds.map(([, text]) =>
										createRuntimeContextMessage(text, 'task-completion'),
									),
									...childMessages.map(([, text]) =>
										createRuntimeContextMessage(text, 'task-completion'),
									),
								]
							},
							waitForInbound: (signal) => inbox.waitForInbound(signal),
							onJobNoticeDelivered: (ids) => {
								const notices = idleJobNoticesRef.current
								if (notices.ownerSession !== session) return
								for (const id of ids) {
									notices.delivered.add(id)
									notices.pending.delete(id)
								}
							},
							extraSystem: composeSkillsPrompt(activeSkills) || undefined,
							onConversationMessages: (messages) => {
								// State-only: opaque reasoning/signatures must reach the next
								// provider and durable store without becoming transcript text.
								st.conversationMessages = messages
							},
						})
					for await (const event of sendWithRebuiltHistory(sendOnce, {
						history: historyBeforeTurn,
						tail: priorForSdk.slice(historyBeforeTurn.length),
						rebuild: async () => {
							const sessions = sessionsRef.current
							const scope = scopeRef.current
							if (!sessions || !scope || !conversationMaterializedRef.current) return undefined
							const fresh = await loadConversation(sessions, scope.sessionId)
							modelHistoryRef.current = fresh
							return fresh
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
							markNonGoalAbnormal()
						} else if (event.kind === 'delta') st.text += event.text
						else if (event.kind === 'done' && event.text !== undefined) st.text = event.text
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
						markNonGoalAbnormal()
					}
					// Flushed first: this path does not go through `applyEvent`, so
					// without it the partial answer the model had produced before
					// the failure would be discarded along with the turn.
					flushStream(st)
					if (st.assistantId) finalizeMessage(st.assistantId)
					pushSystem('error', explainFailure(err, 'That reply failed.'))
				}
			} finally {
				// The turn is over: a run of reads and searches in progress settles.
				readSearchGroup.close()
				if (st.completed && stillHere()) {
					for (const id of childNoticeSnapshot.keys()) directChildNoticesRef.current.delete(id)
					for (const id of workflowNoticeSnapshot.keys()) workflowNoticesRef.current.delete(id)
					for (const id of childMessageSnapshot.keys()) childMessagesRef.current.delete(id)
				}
				if (st.completed && monitorSnapshot.ids.length > 0) {
					// Carried by this turn: never offered again.
					session?.monitors?.acknowledge(monitorSnapshot.ids)
				}
				if (st.completed && idleJobNoticesRef.current.ownerSession === session) {
					for (const id of idleNoticeSnapshot.ids) idleJobNoticesRef.current.pending.delete(id)
				}
				const undeliveredLiveInput = inbox.close()
				const ownsInbox = activeTurnInboxRef.current === inbox
				if (ownsInbox) {
					activeTurnInboxRef.current = null
					setPendingSteers([])
				}
				// Prefer the kernel's settled conversation projection: it retains opaque
				// reasoning, citations and complete tool turns that the visible delta
				// stream cannot reconstruct. A fake/legacy session that does not publish
				// one keeps the old text-only shape. The durable record is the session
				// log, which the kernel appended to as the turn ran; this is only the
				// in-memory context the next send starts from.
				const fallbackTurn: Message[] = admitted
					? [userMessage, ...(fileMessage ? [fileMessage] : [])]
					: []
				if (st.text.trim().length > 0) fallbackTurn.push(createAssistantMessage(st.text))
				const conversationMessages = admitted ? st.conversationMessages : undefined
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
						abnormalTerminal.continuationEpoch === queueContinuationEpochRef.current
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
					permissionAsksRef.current?.closeAll({
						kind: 'reject',
						feedback: 'The owning turn ended.',
					})
					clearActiveTools()
					setState('idle')
					// The turn is over whether or not it is announced: from here a minute of
					// quiet is what the idle notice measures.
					if (ownsTurn) {
						idleNotifierRef.current?.turnSettled()
						awayRecapRef.current?.turnSettled()
						idleCompaction.compactor.turnSettled()
					}
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
				// The kernel recorded the turn in the session log as it ran; nothing is
				// left to publish once the loop has unwound.
				unsettledTurnGenerationsRef.current.delete(turnToken)
				// Not while a queued message is about to start the next turn: both
				// would claim the log, and the turn does not wait for the lease.
				if (queuedRef.current.length === 0) void flushGeneratedTitle()
				if (queuedRef.current.length > 0) setQueueSettleVersion((version) => version + 1)
				const pending = pendingModelSwitchRef.current
				if (pending?.turnToken === turnToken && pending.selection) {
					const selection = pending.selection
					const ownsSwitch = () =>
						pendingModelSwitchRef.current === pending &&
						conversationGenRef.current === pending.generation &&
						scopeRef.current?.sessionId === pending.sessionId &&
						previousSessionRef.current === pending.ownerSession &&
						!pending.signal.aborted
					const beforePublish = () => {
						if (
							!ownsSwitch() ||
							conversationMutationRef.current ||
							hasUnsettledTurn(pending.generation) ||
							abortRef.current ||
							compactingRef.current ||
							exportingRef.current
						) {
							throw new Error(
								'The active conversation changed before the model switch could complete.',
							)
						}
						if (
							pending.ownerSession.subagents
								?.getSnapshot()
								.some(
									(agent) =>
										agent.status === 'starting' ||
										agent.status === 'queued' ||
										agent.status === 'working',
								)
						) {
							throw new Error(
								'Delegated agents are still active. Wait for them to finish before switching models.',
							)
						}
						if (pending.ownerSession.jobs?.().some((job) => job.status === 'running')) {
							throw new Error(
								'Background jobs are still running. Wait for them to finish before switching models.',
							)
						}
					}
					try {
						await persistenceTailRef.current
						beforePublish()
						await hydrateSession(
							selectPrimaryProvider(savedPrefsRef.current, selection),
							detected,
							{
								signal: pending.signal,
								persistSelection: false,
								beforePublish,
							},
						)
						if (
							pendingModelSwitchRef.current === pending &&
							!pending.signal.aborted &&
							previousSessionRef.current !== pending.ownerSession
						) {
							pushMessage(
								'system',
								`Switched to ${selection.id} · ${selection.model} for this conversation.`,
							)
						}
					} catch (error) {
						if (ownsSwitch()) {
							pushMessage(
								'system',
								`${explainFailure(error, 'Could not switch the model.')} The current model is unchanged.`,
							)
						}
					} finally {
						if (pendingModelSwitchRef.current === pending) {
							pendingModelSwitchRef.current = null
							setModelSwitchVersion((version) => version + 1)
							wakeGoalDriver()
						}
					}
				}
			}
		},
		[
			activeSkills,
			appLifetime.signal,
			applyEvent,
			cancelPendingModelSwitch,
			clearActiveTools,
			currentProvider,
			ctx.cwd,
			detected,
			finalizeMessage,
			flushStream,
			goalActivation,
			hasUnsettledTurn,
			hydrateSession,
			materializeConversation,
			onPermission,
			pushMessage,
			replaceQueued,
			sendTerminalNotification,
			session,
			setQueuePause,
			triggerContextNow,
			wakeGoalDriver,
		],
	)

	const selectModelIntent = useCallback(
		async (query: string, options: { readonly fromPicker?: boolean } = {}): Promise<void> => {
			const wantsAuto = isAutoQuery(query)
			if (wantsAuto) {
				const refusal = autoRefusal(
					ctxRef.current.routing !== undefined,
					!!palDefinitionRef.current,
				)
				if (refusal) {
					pushMessage('system', refusal)
					return
				}
				if (autoActiveRef.current && !options.fromPicker) {
					pushMessage('system', AUTO_ALREADY_ON)
					return
				}
			}
			if (
				!session ||
				!currentProvider ||
				state !== 'idle' ||
				(phase !== 'ready' && !options.fromPicker) ||
				abortRef.current ||
				hasUnsettledTurn() ||
				pendingModelSwitchRef.current ||
				queuedRef.current.length > 0 ||
				permissionResolveRef.current ||
				compactingRef.current ||
				conversationMutationRef.current ||
				exportingRef.current ||
				goalDriveInFlightRef.current
			) {
				pushMessage(
					'system',
					'Model selection is unavailable until the active work and queue reach a stable boundary.',
				)
				return
			}
			const wasAuto = autoActiveRef.current
			const controller = new AbortController()
			const pending: PendingModelSwitch = {
				turnToken: {},
				generation: conversationGenRef.current,
				sessionId: scopeRef.current?.sessionId,
				ownerSession: session,
				controller,
				signal: AbortSignal.any([appLifetime.signal, controller.signal]),
			}
			pendingModelSwitchRef.current = pending
			setModelSwitchVersion((version) => version + 1)
			const owns = () =>
				pendingModelSwitchRef.current === pending &&
				!pending.signal.aborted &&
				conversationGenRef.current === pending.generation &&
				scopeRef.current?.sessionId === pending.sessionId &&
				previousSessionRef.current === session
			const beforePublish = () => {
				if (
					!owns() ||
					abortRef.current ||
					hasUnsettledTurn() ||
					conversationMutationRef.current ||
					compactingRef.current ||
					exportingRef.current ||
					permissionResolveRef.current ||
					session.jobs?.().some((job) => job.status === 'running') ||
					session.subagents
						?.getSnapshot()
						.some((agent) => ['starting', 'queued', 'working'].includes(agent.status))
				) {
					throw new Error(
						'Active work or the conversation changed before model selection could complete.',
					)
				}
			}
			try {
				beforePublish()
				if (wantsAuto) {
					const prefs = savedPrefsRef.current
					if (!prefs) throw new Error('No model is connected yet.')
					await persistenceTailRef.current
					beforePublish()
					await hydrateSession(prefs, detected, {
						signal: pending.signal,
						persistSelection: false,
						auto: true,
						beforePublish,
					})
					if (
						pendingModelSwitchRef.current === pending &&
						!pending.signal.aborted &&
						previousSessionRef.current !== session
					) {
						pushMessage('system', AUTO_ON_NOTICE)
					}
					return
				}
				const lookupNoticeId = pushMessage('system', `Looking up ${query} in the model lists…`)
				const resolved = await resolveModelSelectionIntent(query, {
					currentProvider,
					detected,
					describeModels: describeProviderModels,
					signal: pending.signal,
				}).finally(() => {
					// The progress line is superseded by the answer under it.
					setMessages((prev) => prev.filter((message) => message.id !== lookupNoticeId))
				})
				if (!owns()) return
				if (resolved.kind === 'rejected') {
					pushMessage(
						'system',
						resolved.reason +
							(resolved.choices?.length
								? ` Choices: ${resolved.choices.map((choice) => `${choice.provider}/${choice.model}`).join(', ')}.`
								: ''),
					)
					return
				}
				pending.selection = resolved.selection
				await persistenceTailRef.current
				beforePublish()
				await hydrateSession(
					selectPrimaryProvider(savedPrefsRef.current, resolved.selection),
					detected,
					{
						signal: pending.signal,
						persistSelection: false,
						auto: false,
						beforePublish,
					},
				)
				if (
					pendingModelSwitchRef.current === pending &&
					!pending.signal.aborted &&
					previousSessionRef.current !== session
				) {
					pushMessage(
						'system',
						`Switched to ${resolved.selection.id} · ${resolved.selection.model} for this conversation.${wasAuto ? AUTO_TURNED_OFF_SUFFIX : ''}`,
					)
				}
			} catch (error) {
				if (owns())
					pushMessage(
						'system',
						`${explainFailure(error, 'Could not switch the model.')} The current model is unchanged.`,
					)
			} finally {
				if (pendingModelSwitchRef.current === pending) {
					pendingModelSwitchRef.current = null
					setModelSwitchVersion((version) => version + 1)
					wakeGoalDriver()
				}
			}
		},
		[
			session,
			currentProvider,
			state,
			phase,
			hasUnsettledTurn,
			appLifetime.signal,
			pushMessage,
			detected,
			hydrateSession,
			wakeGoalDriver,
		],
	)

	// `#note` and `/memory add`: a typed memory file in the session's stored
	// memory, default type `project`. A session without a store — no provider
	// yet — appends to the curated project file the way every note used to.
	const rememberProjectNote = useCallback(
		async (note: string, type?: MemoryType): Promise<void> => {
			try {
				if (session?.rememberNote) {
					pushMessage('system', renderTypedNoteResult(await session.rememberNote(note, type), note))
					return
				}
				const saved = appendMemoryWithStatus(note, {
					scope: 'project',
					cwd: ctx.cwd,
				})
				pushMessage('system', renderMemorySaveResult(saved, note))
			} catch (err) {
				pushSystem('error', explainFailure(err, 'Could not save memory.'))
			}
		},
		[ctx.cwd, pushMessage, session, pushSystem],
	)

	/**
	 * Enter steered a message into the running turn. Its after-turn triggers
	 * (save as skill) bind to that turn and are told to the model from its next
	 * iteration; its turn triggers do not apply to a turn already running —
	 * the tag row said so before Enter, and Tab would have queued it instead.
	 */
	const bindSteeredTriggers = useCallback(
		(ids: readonly TriggerId[]) => {
			if (ids.length === 0) return
			const live = liveStreamRef.current
			const afterTurn = ids.filter((id) => triggerDefinition(id).scope === 'after-turn')
			const turnOnly = ids.filter((id) => triggerDefinition(id).scope === 'turn')
			if (live && afterTurn.length > 0) {
				live.followUps = [...new Set([...(live.followUps ?? []), ...afterTurn])]
				live.contextTexts = [
					...new Set([...(live.contextTexts ?? []), ...triggerContextTexts(afterTurn)]),
				]
				const line = transcriptTagLine(afterTurn, {
					effort: undefined,
					steered: true,
				})
				if (line) pushSystem('notice', line)
			}
			if (turnOnly.length > 0)
				pushSystem(
					'notice',
					notAppliedLine(
						turnOnly.map((id) => triggerDefinition(id).label),
						STEERED_NOT_APPLIED_REASON,
					),
				)
		},
		[pushSystem],
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	const handleSubmit = useCallback(
		(
			value: string,
			attachments: readonly MessageAttachment[] | undefined,
			mode: ComposerSubmitMode,
			meta: SubmitMeta,
		) => {
			if (goalCommandInFlightRef.current) {
				pushMessage(
					'system',
					'A goal command is still being saved. Wait for it to finish before sending another command or prompt.',
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
								: conversationMutationRef.current === 'materialize'
									? 'initialized'
									: 'moved to a fresh conversation'
				pushMessage(
					'system',
					`Conversation history is being ${operation}. Wait for it to finish before sending another command or prompt.`,
				)
				return
			}
			// An agent is on screen: what is typed goes to it, not to the conversation.
			const viewedId = viewingAgentRef.current
			if (viewedId !== null && meta.source !== 'model-loop' && meta.source !== 'launch-message') {
				const restore = (notice: string) => {
					setViewNotice(notice)
					composerDraftTokenRef.current += 1
					setComposerDraft({
						token: composerDraftTokenRef.current,
						text: value,
						...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
					})
				}
				const text = value.trim()
				// A command the host answers itself is never the agent's: it runs
				// against the conversation, after asking where it changes history, and
				// `/model` is refused. Other `/` text is for the agent.
				const confirmed = mainCommandConfirmedRef.current === value
				if (confirmed) mainCommandConfirmedRef.current = null
				const parsed = confirmed ? null : parseSlash(text)
				const builtin = parsed ? hostCommands.find((c) => c.name === parsed.name) : undefined
				const handling = builtin ? agentViewCommandClass(builtin.name) : undefined
				if (handling?.kind === 'block') {
					restore(handling.notice)
					return
				}
				if (handling?.kind === 'confirm') {
					restore('')
					setViewNotice(undefined)
					setSelectedChoice(0)
					setChoicePicker({
						kind: 'agent-view-command',
						title: handling.title,
						line: value,
						values: ['cancel', 'run'],
						options: [
							{ label: 'Cancel', description: '' },
							{ label: handling.confirmLabel, description: '' },
						],
					})
					return
				}
				if (!confirmed && !builtin) {
					if (attachments && attachments.length > 0) {
						restore('Messages to an agent take text only.')
						return
					}
					if (text.length === 0 || text.length > 16_000) {
						restore('Enter a message of 1–16000 characters.')
						return
					}
					setViewNotice(undefined)
					void submitChildMessage(viewedId, text).catch((error: unknown) =>
						restore(error instanceof Error ? error.message : String(error)),
					)
					return
				}
				setViewNotice(undefined)
			}
			// The operator moved on; a parked turn is still there for /resume.
			setHandoffPark(null)
			// A loop is not something the operator typed here, so it is not a line
			// Up should bring back.
			const fromLoop = meta.source === 'operator-loop' || meta.source === 'model-loop'
			if (!fromLoop) setHistory((prev) => [...prev, value])
			// What the model wrote is never the operator acting. A loop the model
			// made (`session_loop`) fires this path on a timer, for up to a week,
			// after one review of its creation — so its text must not reach the
			// host-side meanings of `/`, `!`, `#` or a model switch: `!` runs on
			// the host outside the sandbox with no review, and `#` writes memory
			// every later turn reads. It is sent as the prompt it looks like.
			const operatorText = meta.source !== 'model-loop' && meta.source !== 'launch-message'
			const selectionIntent =
				operatorText && !attachments?.length ? parseModelSelectionIntent(value) : undefined
			if (selectionIntent) {
				void selectModelIntent(selectionIntent.query)
				return
			}
			// `#` remembers, `!` runs — neither is a prompt. Both are the
			// operator acting directly, the way other coding agents spell it,
			// and both leave a row the model reads on its next turn.
			if (operatorText && value.startsWith('#') && value.slice(1).trim().length > 0) {
				if (palDefinitionRef.current) {
					pushMessage(
						'system',
						'Host project memory shortcuts are unavailable in Pal chat. Ask the Pal to keep the note in its own computer.',
					)
					return
				}
				const note = value.slice(1).trim()
				void rememberProjectNote(note)
				return
			}
			const escaped = operatorText ? shellEscapeCommand(value) : null
			if (escaped !== null) {
				if (palDefinitionRef.current) {
					pushMessage(
						'system',
						'Shell shortcuts are unavailable in Pal chat. Ask the Pal to run the command on its own computer.',
					)
					return
				}
				const echoId = pushMessage('user', value)
				setMessages((previous) =>
					previous.map((row) => (row.id === echoId ? { ...row, kind: 'shell' as const } : row)),
				)
				const rowId = pushMessage('tool', `Running ${escaped}`, true, SYSTEM_ROW_GLYPH)
				void runShellEscape(escaped, { cwd: ctx.cwd }).then((result) => {
					operatorShellRef.current.push(describeShellEscapeForModel(escaped, result))
					const ok = result.exitCode === 0 && !result.timedOut
					const detail =
						result.output.length > 0 ? result.output.replace(/\n$/u, '').split('\n') : undefined
					setMessages((prev) =>
						prev.map((m) =>
							m.id === rowId
								? {
										...m,
										content: describeShellEscape(escaped, result),
										pending: false,
										glyph: SYSTEM_ROW_GLYPH,
										glyphColor: ok ? tokenColor('status.ok') : tokenColor('status.error'),
										...(detail ? { detail } : {}),
									}
								: m,
						),
					)
				})
				return
			}
			// Composer triggers (`./triggers/`). Only the composer's own submit
			// carries them, so nothing a loop, a picker or the model sends can
			// arm one. A message that is nothing but a trigger with a command of
			// its own (`bunu skill olarak kaydet`) runs that command here, in this
			// same call, so history holds the operator's words once; a trigger
			// that needs a task and got none is not applied, and says so.
			let armedTriggers: readonly TriggerId[] =
				meta.source === 'composer' ? meta.triggers.map((trigger) => trigger.id) : []
			let dispatch = value
			if (meta.source === 'composer' && meta.onlyTriggers && armedTriggers.length > 0) {
				const command = armedTriggers
					.map((id) => triggerDefinition(id).standalone)
					.find((standalone) => standalone !== undefined)
				const needTask = armedTriggers.filter(
					(id) => triggerDefinition(id).standalone === undefined,
				)
				if (needTask.length > 0)
					pushSystem(
						'notice',
						notAppliedLine(
							needTask.map((id) => triggerDefinition(id).label),
							`the message has no task. Put the task in the same message${needTask.includes('hypermode') ? ', e.g. “hypermode fix the flaky test”' : ''}`,
						),
					)
				armedTriggers = []
				if (!command) return
				dispatch = command
			}
			// What actually gets sent. A `prompt` action replaces it with text the
			// command composed, and then takes the ordinary send path below —
			// including the queue — so a command-driven turn is not a second way
			// to run one.
			let outgoing = dispatch
			let skillFlow = false
			const palHostCommand =
				operatorText &&
				palDefinitionRef.current &&
				/^\/(?:schedule|loop|worktree|add-dir|browser|mcp|plugins|skills|save-skill|memory|init|review|goal|agents)(?:\s|$)/u.test(
					dispatch,
				)
			if (palHostCommand) {
				pushMessage(
					'system',
					'This command is not available in Pal chat. Pal tools use its own computer; workspace and extension commands remain in ordinary conversations.',
				)
				return
			}
			const slash = operatorText ? runSlash(dispatch, slashCtx, hostCommands) : null
			if (slash) {
				const commandName = /^\/([\w-]+)/u.exec(dispatch.trim())?.[1]
				if (commandName) tipHistory?.recordUse(commandName.toLowerCase())
			}
			if (slash) {
				switch (slash.kind) {
					case 'message':
						// The command as typed, then its answer hung under `⎿`, so a readout
						// in the scrollback says which command it answers. A system row, not
						// a user one: it is not a prompt and must not be offered for editing.
						pushMessage('system', dispatch.trim(), false, '›', undefined, tokenColor('accent.user'))
						if (slash.statusRows) {
							setMessages((previous) => [
								...previous,
								{
									id: nextId(),
									role: slash.role,
									content: slash.content,
									statusRows: slash.statusRows,
								},
							])
						} else pushMessage(slash.role, slash.content, false, '⎿')
						return
					case 'command-picker': {
						if (slash.commands.length === 0) {
							pushMessage('system', 'No slash commands are available in this conversation.')
							return
						}
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'command',
							title: 'Choose a command',
							values: slash.commands,
							options: slash.commands.map((command) => ({
								label: `/${command.name}`,
								description: command.problem
									? `Unavailable: ${command.problem}`
									: commandPickerDescription(command.description),
								disabledReason: command.problem,
							})),
							windowSize: suggestionWindowSize(terminal.rows),
						})
						return
					}
					case 'peers': {
						const peers = peersRef.current
						if (!peers) {
							pushMessage('system', 'Peer messaging is not ready.')
							return
						}
						const [verb, target, ...words] = slash.args
						if (verb === 'on' || verb === 'off') {
							peers.setEnabled(verb === 'on')
							pushMessage(
								'system',
								`Peer messaging is ${verb}; ${plural(peers.pending, 'message')} pending.`,
							)
						} else if (verb === 'send' && target && words.length) {
							void peers
								.send(target, words.join(' '))
								.then((receipt) =>
									pushMessage(
										'system',
										`Peer message ${receipt.status}: ${receipt.reason ?? 'accepted in the receiving inbox'}`,
									),
								)
								.catch((error) =>
									pushSystem('error', explainFailure(error, 'Peer message failed.')),
								)
						} else if (!verb || verb === 'list') {
							void peers
								.list()
								.then((peersList) =>
									pushMessage(
										'system',
										`Peer messaging ${peers.enabled ? 'on' : 'off'} · ${peers.pending} pending\n${peersList.map((peer) => `${peer.self ? 'This terminal' : peer.title} [${peer.ref}] · ${peer.state} · ${peer.permission_mode}${peer.accepts_messages ? '' : ' · not accepting messages'}`).join('\n')}`,
									),
								)
								.catch((error) =>
									pushSystem('error', explainFailure(error, 'Peer discovery failed.')),
								)
						} else pushMessage('system', 'Usage: /peers [list|on|off|send <ref> <message>]')
						return
					}
					case 'agents': {
						const agentIds = session?.agentIds ?? []
						runAgentsCommand(
							slash.args,
							() => {
								// Reported after the read, not before it: the answer to "are
								// there any" may be in the session's logs, and a conversation
								// whose children are recorded there must never be told it
								// delegated nothing.
								void openAgentCockpit().then((opened) => {
									if (opened) return
									pushMessage(
										'system',
										`No delegated agents in this conversation.${agentIds.length ? `\nAvailable: ${agentIds.join(', ')}` : '\nNo agents are configured.'}`,
									)
								})
							},
							() => pushMessage('system', renderAgents(agentIds)),
						)
						return
					}
					case 'workflows': {
						const source = session?.workflows
						if (!source) {
							pushMessage('system', 'Workflows are available once the conversation starts.')
							return
						}
						void source
							.history()
							.then((runs) => {
								if (appLifetime.signal.aborted) return
								const live = new Set(source.runs().map((run) => run.runId))
								historicalWorkflowRunsRef.current = runs.filter((run) => !live.has(run.runId))
								publishWorkflowRuns()
								if (runs.length === 0) {
									pushMessage(
										'system',
										'No workflows in this conversation. Start or end a message with the word workflow to ask for one.',
									)
									return
								}
								setSelectedChoice(0)
								setChoicePicker({
									kind: 'workflow-runs',
									title: 'Workflows',
									subtitle: workflowRunsSubtitle(runs),
									values: runs.map((run) => run.runId),
									options: runs.map(workflowRunOption),
								})
							})
							.catch((error) =>
								pushSystem('error', explainFailure(error, 'Could not read the workflows.')),
							)
						return
					}
					case 'jobs': {
						if (!session) {
							pushMessage('system', 'Shell jobs are available once the conversation starts.')
							return
						}
						openShellJobs()
						return
					}
					case 'abandon': {
						void abandonActiveTurn(slash.reason)
						return
					}
					case 'provider-setup':
						if (state !== 'idle' || permission || choicePickerRef.current) {
							pushMessage(
								'system',
								'Provider setup is available once the current reply and prompts finish.',
							)
							return
						}
						setProviderSetup(true)
						return
					case 'turn-limits-set':
					case 'turn-limit-editor':
					case 'turn-limits-picker': {
						const currentLimits = resolveTurnGuards(
							ctxRef.current.limits,
							turnLimitsOverrideRef.current,
						)
						if (slash.kind === 'turn-limit-editor') {
							const scope = scopeRef.current
							if (!scope) {
								pushMessage('system', 'Reply limits are available once the conversation starts.')
								return
							}
							const field = TURN_LIMIT_FIELDS.find((field) => field.key === slash.key)!
							textPromptTokenRef.current += 1
							setTextPrompt({
								token: textPromptTokenRef.current,
								kind: 'turn-limit',
								limitKey: slash.key,
								title: `${field.label} (${slash.key === 'timeoutMs' ? 'ms; ' : ''}0 = unlimited)`,
								placeholder: field.hint,
								emptyNotice: 'Enter a value, or Esc to keep the current limit.',
								initialValue: String(currentLimits[slash.key]),
								sessionId: scope.sessionId,
							})
							return
						}
						if (slash.kind === 'turn-limits-set') {
							turnLimitsOverrideRef.current = {
								...turnLimitsOverrideRef.current,
								...slash.limits,
							}
						}
						const commands = turnLimitCommands(
							resolveTurnGuards(currentLimits, turnLimitsOverrideRef.current),
						)
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'command',
							title: 'Reply limits',
							notice: `${slash.kind === 'turn-limits-set' ? 'Updated. ' : ''}This conversation · new replies and their agents. Existing replies keep their limits.`,
							values: commands,
							options: commands.map((command) => ({
								label: command.label,
								description: command.description,
							})),
							windowSize: 5,
						})
						return
					}
					case 'settings-picker': {
						const commands: (CommandPickerEntry & { label: string })[] = [
							{
								name: 'model',
								label: 'Model',
								description: `${session?.providerSummary ?? 'No provider'} · ${autoActive && ctx.routing && !palDefinitionRef.current ? AUTO_MODEL_LABEL : (session?.modelSummary ?? 'No model')}. Change model or provider.`,
							},
							{
								name: 'effort',
								label: 'Reasoning effort',
								description: `${reasoningEffortRef.current ?? session?.reasoningEffortDefault ?? 'Model default'} · applies to future replies in this conversation.`,
								...(session?.reasoningEffortLevels === undefined
									? {
											problem: 'This model does not publish reasoning choices.',
										}
									: {}),
							},
							{
								name: 'permissions',
								label: 'Permissions',
								description: `${permissionModeLabel(permissionModeRef.current)} · this conversation.`,
							},
							{
								name: 'config limits',
								label: 'Reply limits',
								description: turnLimitCommands(
									resolveTurnGuards(ctxRef.current.limits, turnLimitsOverrideRef.current),
								)
									.slice(0, 3)
									.map((field) => `${field.label}: ${field.description}`)
									.join(' · '),
							},
							{
								name: 'status',
								label: 'Web & usage',
								description: `${session?.webSearchSummary ?? 'Not resolved'} · view tools, workspace and usage.`,
							},
							{
								name: 'setup',
								label: 'Provider setup',
								description:
									'Check installed CLIs and access; connect or install without leaving Namzu.',
							},
							{
								name: `config triggers ${composerTriggersOn ? 'off' : 'on'}`,
								label: 'Composer triggers',
								description: composerTriggersOn
									? 'On · hypermode and save-as-skill words act for their message. Select to turn off.'
									: 'Off · words in a message are only words. Select to turn on.',
							},
							{
								name: 'theme',
								label: 'Theme',
								description: `${THEME_CHOICES.find((choice) => choice.value === savedThemeSetting())?.label ?? 'Dark mode'} · pick the colors, with a preview.`,
							},
							{
								name: `config motion ${reducedMotion() ? 'off' : 'on'}`,
								label: 'Reduce motion',
								description: reducedMotion()
									? 'On · the working line and the composer stay still. Select to turn off.'
									: 'Off · the working line and the composer move. Select to turn on.',
							},
							{
								name: `config recap ${recapOn ? 'off' : 'on'}`,
								label: 'Session recap',
								description: recapOn
									? 'On · a one-line recap when you return after a few minutes away. Select to turn off.'
									: 'Off · no recap on return. Select to turn on.',
							},
							{
								name: `config tips ${spinnerTipsOn ? 'off' : 'on'}`,
								label: 'Tips',
								description: spinnerTipsOn
									? 'On · one short tip shows under the working row. Select to turn off.'
									: 'Off · no tip under the working row. Select to turn on.',
							},
							{
								name: 'config sources',
								label: 'Setting sources',
								description: 'Show which configuration files and overrides are in use.',
							},
						]
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'command',
							title: 'Configuration',
							notice:
								'Model, reasoning, permission and reply-limit changes apply to this conversation.',
							values: commands,
							options: commands.map((command) => ({
								label: command.label,
								description: command.description,
								disabledReason: command.problem,
							})),
							windowSize: 8,
						})
						return
					}
					case 'goal-editor': {
						const scope = scopeRef.current
						if (!scope || !sessionsRef.current) {
							pushMessage('system', 'Goals require conversation history to be available.')
							return
						}
						textPromptTokenRef.current += 1
						setTextPrompt({
							token: textPromptTokenRef.current,
							kind: slash.edit ? 'goal-edit' : 'goal-create',
							title: slash.edit ? 'Edit goal' : 'Set a goal',
							placeholder: `Up to ${goalStatus?.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS} automatic replies; /goal pause stops continuation.`,
							emptyNotice: 'Describe the result you want, or press Esc to cancel.',
							initialValue: slash.edit ? (goalStatus?.objective ?? '') : '',
							sessionId: scope.sessionId,
						})
						return
					}
					case 'goal-picker': {
						const generation = conversationGenRef.current
						const request = {}
						setSelectedChoice(-1)
						setChoicePicker({
							kind: 'command',
							title: 'Goal',
							notice: 'Loading goal…',
							values: [],
							options: [],
							windowSize: 7,
							request,
						})
						void (async () => {
							try {
								const sessions = sessionsRef.current
								const scope = scopeRef.current
								if (!sessions || !scope) {
									setChoicePicker(null)
									pushMessage('system', 'Goals require conversation history to be available.')
									return
								}
								const goal = conversationMaterializedRef.current
									? await sessions.goals.getGoal(scope.sessionId, sessions.tenantId)
									: null
								if (
									appLifetime.signal.aborted ||
									conversationGenRef.current !== generation ||
									choicePickerRef.current?.request !== request
								)
									return
								setGoalStatus(goal)
								const commands: CommandPickerEntry[] = goal
									? [
											{
												name: 'goal status',
												description: 'View goal progress and continuation status.',
											},
											{
												name: 'goal edit',
												description: 'Change the objective.',
											},
											...(goal.phase === 'complete'
												? []
												: [
														goal.phase === 'active' && goalActivation.isArmed(scope.sessionId, goal)
															? {
																	name: 'goal pause',
																	description:
																		'Stop automatic continuation after the current reply.',
																}
															: {
																	name: 'goal resume',
																	description: 'Continue working automatically toward this goal.',
																},
													]),
											{
												name: 'goal clear',
												description: 'Remove this goal and stop its automatic continuation.',
											},
										]
									: [
											{
												name: 'goal set',
												description: 'Set an objective and start automatic continuation.',
											},
										]
								setSelectedChoice(0)
								setChoicePicker({
									kind: 'command',
									back: choicePickerRef.current?.back,
									title: 'Goal',
									notice: goal
										? `${goal.phase} · ${goal.roundsAdmitted}/${goal.maxGoalRounds} automatic replies · ${goal.objective}`
										: `No goal set for this conversation. Up to ${DEFAULT_MAX_GOAL_ROUNDS} automatic replies when started.`,
									values: commands,
									options: commands.map((command) => ({
										label: `/${command.name}`,
										description: command.description,
									})),
									windowSize: 7,
								})
							} catch (error) {
								if (
									!appLifetime.signal.aborted &&
									conversationGenRef.current === generation &&
									choicePickerRef.current?.request === request
								) {
									setChoicePicker(null)
									pushSystem('error', explainFailure(error, 'Could not load goal.'))
								}
							} finally {
								wakeGoalDriver()
							}
						})()
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
								'Cannot archive this conversation because it is not being saved.',
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
								'A reply, queued message, summary or export is still running. Wait for it to finish, then archive.',
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
									description: 'Return without changing the saved history',
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
						if (
							state !== 'idle' ||
							pendingModelSwitchRef.current ||
							abortRef.current !== null ||
							hasUnsettledTurn() ||
							(queuedRef.current.length > 0 && queuePauseRef.current === null) ||
							permissionResolveRef.current !== null ||
							compactingRef.current ||
							conversationMutationRef.current !== null ||
							exportingRef.current
						) {
							pushMessage(
								'system',
								'Model choices are unavailable while a reply, a question, queued messages or a summary are in progress. Try again when they finish.',
							)
							return
						}
						// Opened as a choice, not as a repair. A launch-time refusal
						// left on screen here would explain a problem that has since
						// been solved — the session behind this picker is running.
						setPickerNotice(null)
						setKeyEntryFor(null)
						setPickerDetected(null)
						setPickerSelectionKind('provider-and-model')
						setPickerInitialView('models')
						setPhase('picker')
						return
					case 'permission-mode': {
						applyPermissionMode(slash.mode)
						return
					}
					case 'permission-mode-picker': {
						if (!session?.hasProvider) {
							pushMessage('system', 'Choose a model before changing permissions.')
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
							pushMessage('system', 'Finish or stop the current work before changing permissions.')
							return
						}
						const picker = permissionPicker(
							permissionModeRef.current,
							false,
							permissionAvailability(),
						)
						setSelectedChoice(
							Math.max(
								0,
								picker.options.findIndex((option) => option.current),
							),
						)
						setChoicePicker(picker)
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
								'No exact reasoning-effort menu is available for the current model.',
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
								'Reasoning-effort choices are unavailable while a reply, a question, a summary or queued messages are in progress. Try again when they finish.',
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
						setChoicePicker(
							reasoningEffortPicker(session, current, false, hypermodeRef.current) ?? null,
						)
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
							...(readStoredGoogleApiKey() ? (['google'] as const) : []),
						]
						if (choices.length === 0) {
							removeStoredCredential('all')
							return
						}
						if (choices.length === 1) {
							removeStoredCredential(choices[0] as SubscriptionProviderId | 'google')
							return
						}
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'credential-logout',
							title: 'Choose a stored credential to remove',
							notice:
								'Only credentials created by Namzu are listed. Sign-ins owned by other tools are left alone.',
							values: choices,
							options: choices.map((choice) => ({
								label:
									choice === 'anthropic'
										? 'Claude'
										: choice === 'codex'
											? 'Codex'
											: 'Gemini API key',
								description:
									choice === 'anthropic'
										? 'Remove only Namzu’s Claude subscription.'
										: choice === 'codex'
											? 'Remove only Namzu’s Codex subscription.'
											: 'Remove only Namzu’s saved Gemini API key.',
							})),
						})
						return
					}
					case 'remember':
						if (slash.scope === 'project') {
							void rememberProjectNote(slash.text, slash.memoryType)
							return
						}
						try {
							const saved = appendMemoryWithStatus(slash.text, {
								scope: slash.scope,
								cwd: ctx.cwd,
							})
							pushMessage('system', renderMemorySaveResult(saved, slash.text))
						} catch (err) {
							pushSystem('error', explainFailure(err, 'Could not save memory.'))
						}
						return
					case 'import-notes': {
						if (!session?.importCuratedNotes) {
							pushMessage(
								'system',
								'Stored memory is not open yet; /memory import-notes works once a conversation has started.',
							)
							return
						}
						void session.importCuratedNotes().then(
							(report) => pushMessage('system', report),
							(err: unknown) => pushSystem('error', explainFailure(err, 'Notes were not copied.')),
						)
						return
					}
					case 'show-memory': {
						const curated = renderMemoryReport(readMemory(undefined, ctx.cwd), {
							cwd: ctx.cwd,
						})
						const stored = session?.storedMemoryIndex
						if (!stored) {
							pushMessage('system', curated)
							return
						}
						void stored().then(
							({ directory, index, derived }) => {
								const section = renderStoredMemorySection(directory, index, derived)
								pushMessage(
									'system',
									section
										? curated.startsWith('No saved memory.')
											? section
											: `${section}\n\n${curated}`
										: curated,
								)
							},
							(err: unknown) =>
								pushSystem(
									'error',
									explainFailure(err, `${curated}\n\nStored memories not loaded.`),
								),
						)
						return
					}
					case 'list-skills': {
						// The session's directory, not the process's — the same
						// distinction the headless commands get from `--cwd`. They are
						// the same value today, and were the same value in `exec --json`
						// too until they were not.
						const skills = discoverSkills({
							cwd: ctx.cwd,
							...(ctx.skills ? { config: ctx.skills } : {}),
						})
						if (skills.length === 0) {
							pushMessage('system', NO_SKILLS_FOUND)
							return
						}
						const activeNames = new Set(activeSkills.map((s) => s.name))
						pushMessage('system', renderSkillRoster(skills, activeNames))
						return
					}
					case 'plugins': {
						const plugins = session?.plugins?.list() ?? []
						if (slash.name) {
							const plugin = plugins.find((item) => item.name === slash.name)
							pushMessage(
								'system',
								plugin
									? pluginDetails(plugin)
									: `Plugin "${slash.name}" is not loaded in this conversation. Use /plugins to inspect availability.`,
							)
						} else if (plugins.length === 0 || !session) {
							pushMessage('system', emptyPluginReport(ctx.plugins, ctx.cwd))
						} else if (slash.list) {
							pushMessage(
								'system',
								`Plugins\n${plugins
									.map((plugin) => {
										const option = pluginOption(plugin)
										return `${option.label} · ${option.description}`
									})
									.join('\n')}`,
							)
						} else {
							setSelectedChoice(0)
							setChoicePicker(loadedPluginPicker(session))
						}
						return
					}
					case 'skill-picker': {
						const skills = discoverSkills({
							cwd: ctx.cwd,
							...(ctx.skills ? { config: ctx.skills } : {}),
						})
						if (skills.length === 0) {
							pushMessage('system', NO_SKILLS_FOUND)
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
									: `${skill.description} · ${skill.source} (${skillTierLabel(skill.tier)})`,
								current: activeNames.has(skill.name),
							})),
						})
						return
					}
					case 'load-skill': {
						activateSkill(slash.name)
						return
					}
					case 'new-skill':
					case 'save-skill': {
						const creator = discoverSkills({
							cwd: ctx.cwd,
							...(ctx.skills ? { config: ctx.skills } : {}),
						}).find((skill) => skill.name === SKILL_CREATOR_SKILL)
						if (!creator || creator.problem || creator.invocation === 'operator') {
							pushMessage(
								'system',
								`The ${SKILL_CREATOR_SKILL} skill is not available to the model here${creator?.problem ? ` (${creator.problem})` : ''}. Turn the built-in skills back on (skills.builtin) or write a SKILL.md by hand under ~/.namzu/skills/<name>/.`,
							)
							return
						}
						// Falls through to the queue-or-send a typed message takes, as
						// `prompt` does below.
						skillFlow = true
						if (slash.kind === 'new-skill') outgoing = newSkillPrompt(slash.idea)
						else {
							outgoing = learnSkillPrompt(slash.name)
							// The proposal was taken up: this conversation proposes no
							// more, and the ignored-in-a-row count starts again.
							conversationLearning().proposed = true
							const home = resolveNamzuHome()
							const ledger = readSuggestionLedger(home)
							if (ledger.unanswered > 0) writeSuggestionLedger(home, { ...ledger, unanswered: 0 })
						}
						break
					}
					case 'skill-suggestions': {
						// The session follows the choice whatever the files say; the
						// message says whether a later start will too.
						skillSuggestOverrideRef.current = slash.on
						if (slash.on) writeSuggestionLedger(resolveNamzuHome(), FRESH_LEDGER)
						const profile = ctx.configDebug?.selectedProfile?.name
						pushMessage(
							'system',
							setSkillSuggestions(slash.on, {
								cwd: ctx.cwd,
								...(profile ? { profile } : {}),
							}).message,
						)
						return
					}
					case 'resume':
						void doResume()
						return
					case 'unarchive':
						void doUnarchive()
						return
					case 'title':
						void doTitle(slash.title, slash.clear)
						return
					case 'fork':
						void doFork()
						return
					case 'worktree': {
						const [verb = 'list', label, extra] = slash.args
						const notice = (content: string) => pushMessage('system', terminalDisplayText(content))
						if (
							!(
								(verb === 'list' && label === undefined) ||
								(verb === 'create' && extra === undefined) ||
								(verb === 'fork' && extra === undefined) ||
								(verb === 'resume' && label !== undefined && extra === undefined)
							)
						) {
							pushMessage(
								'system',
								'Usage: /worktree [list|create [name]|fork [name]|resume <name>]',
							)
							return
						}
						if (
							verb === 'fork' &&
							(abortRef.current || hasUnsettledTurn() || queuedRef.current.length > 0)
						) {
							pushMessage(
								'system',
								'Wait for the current reply and queued messages to finish before forking to a worktree.',
							)
							return
						}
						if (conversationMutationRef.current) return
						if (verb === 'fork') {
							conversationMutationRef.current = 'fork'
							setConversationMutation('fork')
						}
						void (async () => {
							try {
								const manager = await openManagedWorktrees(ctx.cwd)
								if (verb === 'list') {
									const items = await manager.list()
									notice(
										items.length === 0
											? 'No managed worktrees in this repository.'
											: items
													.map(
														(item) =>
															`${item.label}: ${item.path}${item.dirty ? ' (uncommitted files)' : ''}`,
													)
													.join('\n'),
									)
								} else if (verb === 'create') {
									const created = await manager.create(label)
									notice(
										`Created ${created.branch}. Open it in a new terminal: ${worktreeOpenHint(created.path)}${created.sourceDirty ? '\nUncommitted files stayed in this checkout.' : ''}`,
									)
								} else if (verb === 'fork') {
									const scope = await materializeConversation()
									if (!scope) throw new Error('Conversation history is unavailable in this folder.')
									await persistenceTailRef.current
									const forked = await manager.fork(scope.sessionId, label)
									notice(
										`Forked ${forked.copied} messages into ${displayConversationTitle(forked.title)}. Open the new checkout in a new terminal: ${worktreeOpenHint(forked.path, forked.conversationId)}${forked.sourceDirty ? '\nUncommitted files stayed in this checkout.' : ''}`,
									)
								} else if (label) {
									const target = await manager.resume(label)
									notice(
										`Open ${label} in a new terminal: ${worktreeOpenHint(target.worktree.path, target.conversationId)}`,
									)
								}
							} catch (error) {
								notice(explainFailure(error, 'Could not set up the worktree.'))
							} finally {
								if (verb === 'fork') {
									conversationMutationRef.current = null
									setConversationMutation(null)
								}
							}
						})()
						return
					}
					case 'restore':
						void doRestore(slash.turn)
						return
					case 'rewind':
						openPromptEditor()
						return
					case 'add-dir': {
						const dirs = session?.directories
						if (!dirs) {
							pushMessage('system', 'No conversation yet; /add-dir works once one has started.')
							return
						}
						void dirs
							.add(slash.path, {
								// Outside the working directory, adding it lets every file
								// tool reach it unasked, so it is asked about once here.
								approve: (absolute) => {
									if (questionRef.current) {
										pushMessage(
											'system',
											'Answer the open question first; /add-dir asks one of its own.',
										)
										return Promise.resolve(false)
									}
									return askQuestion({
										questionId: `add-dir:${absolute}`,
										question: `Let the file tools read and write ${absolute} for this conversation?`,
										header: 'Outside the working directory',
										options: [
											{
												id: 'yes',
												label: 'Yes, add it',
												description:
													'File tools reach it without asking again; a sandboxed reply binds it read-write.',
											},
											{ id: 'no', label: 'No', description: 'Leave it out' },
										],
										multiSelect: false,
										allowFreeText: false,
									}).then(
										(answer) =>
											answer.kind === 'answer' && answer.selectedOptionIds.includes('yes'),
									)
								},
							})
							.then((result) => {
								pushMessage(
									'system',
									result.added
										? `Added ${result.path}. The file tools reach it by absolute path from the next reply; a sandboxed reply binds it read-write.`
										: `Not added: ${result.path} — ${result.reason ?? 'refused'}`,
								)
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
						if (scheduleRef.current?.handleSlash(slash.name, slash.args)) return
						// Dispatched through the kernel's registry, built with what
						// THIS session can answer from. The descriptors used for
						// the merge above carry no store — they are names — so the
						// registry is rebuilt here with the live one.
						const generation = conversationGenRef.current
						const goalCommand = slash.name === 'goal'
						if (goalCommand) goalCommandInFlightRef.current = true
						void (async () => {
							let goalCommandReleased = false
							const releaseGoalCommand = () => {
								if (!goalCommand || goalCommandReleased) return
								goalCommandReleased = true
								goalCommandInFlightRef.current = false
								wakeGoalDriver()
							}
							try {
								if (goalCommand) await materializeConversation()
								const durableSessions = sessionsRef.current
								const sessionScope = scopeRef.current
								const taskStore = slash.name === 'tasks' ? session?.currentTaskStore?.() : undefined
								if (slash.name === 'tasks' && !taskStore) {
									pushMessage(
										'system',
										session?.currentTaskStore
											? 'No task list is available yet for this conversation.'
											: 'Task listing is unavailable in this conversation.',
									)
									return
								}
								const registry = new HostCommandRegistry()
								registry.register(
									kernelHostCommands({
										allowedAgentIds: session?.agentIds ?? [],
										...(taskStore ? { taskStore } : {}),
										...(durableSessions && sessionScope && conversationMaterializedRef.current
											? {
													goal: {
														store: durableSessions.goals,
														sessionId: sessionScope.sessionId,
														tenantId: durableSessions.tenantId,
														activation: goalActivation,
													},
												}
											: {}),
									}),
								)
								const outcome = await registry.dispatch(
									`/${slash.name} ${slash.args.join(' ')}`.trim(),
								)
								// The dispatch result is the durable boundary. Release the input
								// gate before publishing that result: once the operator can see a
								// completed `/goal` row, the next goal command must be admissible.
								// Keeping the gate until `finally` left one render-sized window in
								// which a visible success was followed by "still reaching durable
								// state" when the operator immediately typed `/goal resume`.
								releaseGoalCommand()
								// A late readout from the conversation just left must not be
								// painted as state of the one now on screen.
								if (conversationGenRef.current !== generation) return
								const checklist =
									slash.name === 'tasks' && outcome?.kind === 'report'
										? taskReportChecklist(outcome.rows)
										: undefined
								if (checklist) {
									// Drawn by the same checklist as the transcript's task
									// blocks: the same marks, and no id or owner column.
									const id = nextId()
									setMessages((prev) => [
										...prev,
										{
											id,
											role: 'system',
											content:
												checklist.length === 0 ? 'No tasks yet.' : checklistProgress(checklist),
											...(checklist.length > 0 ? { checklist } : {}),
										},
									])
									return
								}
								pushMessage(
									'system',
									outcome
										? renderOutcome(outcome)
										: `/${slash.name} is registered but this conversation cannot run it.`,
								)
							} catch (error) {
								if (conversationGenRef.current !== generation) return
								pushSystem('error', explainFailure(error, `Could not run /${slash.name}.`))
							} finally {
								releaseGoalCommand()
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
							messageId: target.messageId,
							sessionId: target.sessionId,
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
						recordFeedback(target.sessionId, slash.messageId, slash.rating, slash.note)
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
					case 'context': {
						pushMessage('system', dispatch.trim(), false, '›', undefined, tokenColor('accent.user'))
						void (async () => {
							const view = await buildContextRow({
								usage,
								compaction: slashCtx.compaction,
								details: slash.details,
								// A compaction or a summary since the last reply made its size stale.
								sizeOutOfDate: contextHiddenRef.current,
								session,
								messages: modelHistoryRef.current,
								cwd: ctx.cwd,
								columns: terminal.columns,
								model: slashCtx.modelSummary ?? undefined,
								mcp: slashCtx.mcp(),
								skillsConfig: ctx.skills,
							})
							if (typeof view === 'string') {
								pushMessage('system', view, false, '⎿')
								return
							}
							setMessages((previous) => [
								...previous,
								{ id: nextId(), role: 'system', content: view.text, contextView: view },
							])
						})()
						return
					}
					case 'diff': {
						// Fire-and-forget, like its neighbours: a git invocation is not
						// something to block a keystroke on.
						void (async () => {
							const { summary, detail, diff } = renderWorkspaceDiff(await workspaceDiff(ctx.cwd))
							// Through the one row writer, so a long diff is numbered and Ctrl+O opens it.
							pushMessage(
								'system',
								summary,
								false,
								undefined,
								detail.length > 0 ? detail : undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								diff,
							)
						})()
						return
					}
					case 'compact': {
						// The command as typed first, so the result below it says what it answers
						// and both stay where /compact ran.
						pushMessage('system', dispatch.trim(), false, '›', undefined, tokenColor('accent.user'))
						if (!session) {
							pushMessage('system', 'Nothing to summarise yet.')
							return
						}
						if (abortRef.current || state !== 'idle' || hasUnsettledTurn()) {
							pushMessage(
								'system',
								'A reply is still running or being saved. Summarising now would summarise a conversation while its next message is being written — wait for it to finish, or press esc to stop it and wait for what it wrote to be saved.',
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
								// rendered view and is never rebuilt into history.
								const result = await session.compact(modelHistoryRef.current, slash.instructions)
								if (!result) {
									// Not an error, and not silence: a conversation too short
									// to shed anything is a real answer to a question the
									// operator asked on purpose.
									pushSystem('notice', NOTHING_TO_COMPACT_TEXT)
									return
								}

								// Durable first, screen second: for a conversation in a log,
								// `session.compact` has already appended the compaction record
								// the next `/resume` folds, before it returned.
								const durable = Boolean(
									sessionsRef.current && scopeRef.current && conversationMaterializedRef.current,
								)
								modelHistoryRef.current = [...result.messages]

								// How many user/assistant turns survived the pass.
								// `keepRecentRows` explains why the transcript is trimmed
								// to match rather than rebuilt from `result.messages`.
								const keptTurns = result.messages.filter(
									(m) => m.role === 'user' || m.role === 'assistant',
								).length

								// The turns that survive stay in order, then the command and its
								// result where /compact ran. Rows dropped from the front are already
								// printed by `<Static>`, so remount the projection just as `/resume`
								// does when it replaces the log.
								resetTranscript()
								setMessages((prev) => {
									const kept = keepRecentRows(prev, keptTurns)
									const summaryRow: TranscriptMessage = {
										id: `compact-${Date.now()}`,
										role: 'system',
										content: durable
											? COMPACT_RESULT_TEXT
											: `${COMPACT_RESULT_TEXT}. ${COMPACT_NOT_SAVED_TEXT}`,
										glyph: CLOSING_GLYPH,
										glyphColor: tokenColor('text.muted'),
										meta: COMPACT_RESULT_HINT,
										activity: 'summary',
										detail: summaryDetail(result.summary),
										// Numbered after the rows that stay, so Ctrl+O can name it.
										detailRef: Math.max(0, ...kept.map((m) => m.detailRef ?? 0)) + 1,
									}
									return [...kept, summaryRow]
								})
								// /context counts a manual pass like an automatic one.
								setCompactionTally((tally) => ({
									...tally,
									passes: tally.passes + 1,
									summaries: tally.summaries + 1,
								}))
								setContextHidden(true)
							} catch (err) {
								pushSystem('error', explainFailure(err, 'Couldn’t summarise the conversation.'))
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
					case 'theme-picker': {
						const saved = savedThemeSetting()
						setSelectedChoice(
							Math.max(
								0,
								THEME_CHOICES.findIndex((choice) => choice.value === saved),
							),
						)
						setChoicePicker({
							kind: 'theme',
							title: 'Theme',
							notice: 'Choose the text style that looks best with your terminal.',
							values: THEME_CHOICES.map((choice) => choice.value),
							options: THEME_CHOICES.map((choice) => ({
								label: choice.label,
								description: choice.description,
								current: choice.value === saved,
							})),
							windowSize: THEME_CHOICES.length,
						})
						return
					}
					case 'theme': {
						applyThemeChoice(slash.setting)
						return
					}
					case 'reduced-motion': {
						if (slash.setting === 'list') {
							pushMessage('system', describeReducedMotion())
							return
						}
						pushMessage('system', saveReducedMotion(slash.setting === 'on'))
						return
					}
					case 'composer-triggers': {
						const profile = ctx.configDebug?.selectedProfile?.name
						const cascade = { cwd: ctx.cwd, ...(profile ? { profile } : {}) }
						if (slash.setting === 'list') {
							pushMessage('system', describeComposerTriggers(composerTriggersOn, cascade))
							return
						}
						const on = slash.setting === 'on'
						// The session follows the choice whatever the files say; the
						// message says whether a later start will too.
						setComposerTriggersOverride(on)
						pushMessage('system', setComposerTriggers(on, cascade))
						return
					}
					case 'recap-setting': {
						if (slash.setting === 'list') {
							pushMessage(
								'system',
								describeRecapSetting({
									enabledNow: recapOn,
									env: process.env,
									tui: ctx.tui,
								}),
							)
							return
						}
						const on = slash.setting === 'on'
						setRecapOverride(on)
						pushMessage('system', setRecapSetting(on))
						return
					}
					case 'recap-now': {
						if (meta.source === 'operator-loop') {
							pushSystem('notice', '/recap only runs when you ask for it yourself in this session.')
							return
						}
						const turns = recapTurns(messagesLiveRef.current)
						if (!turns.some((turn) => turn.role === 'assistant')) {
							pushSystem('notice', 'Nothing to recap yet — send a message first.')
							return
						}
						manualRecapRef.current?.abort()
						const controller = new AbortController()
						manualRecapRef.current = controller
						const generation = conversationGenRef.current
						void writeRecap(controller.signal).then((text) => {
							if (manualRecapRef.current === controller) manualRecapRef.current = null
							if (conversationGenRef.current !== generation) return
							if (controller.signal.aborted) {
								pushSystem('notice', 'Recap cancelled.')
								return
							}
							pushSystem(
								text === undefined ? 'warning' : 'notice',
								text ?? "Couldn't generate a recap. Run with --debug for details.",
							)
						})
						return
					}
					case 'spinner-tips': {
						if (slash.on === 'list') {
							pushMessage(
								'system',
								spinnerTipsOn
									? 'Tips are on: one short tip shows under the working row. /config tips off turns them off.'
									: 'Tips are off. /config tips on turns them back on. The next task still shows under the working row.',
							)
							return
						}
						const profile = ctx.configDebug?.selectedProfile?.name
						setSpinnerTipsOverride(slash.on)
						pushMessage(
							'system',
							setSpinnerTips(slash.on, { cwd: ctx.cwd, ...(profile ? { profile } : {}) }),
						)
						return
					}
					case 'hypermode': {
						if (slash.via === 'orchestrate') pushMessage('system', ORCHESTRATE_ALIAS_NOTICE)
						const enabled = slash.enabled === 'toggle' ? !hypermodeRef.current : slash.enabled
						applyHypermode(enabled)
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
					case 'browser': {
						const generation = conversationGenRef.current
						void runBrowserSlash(session?.browser, slash.args, {
							busy: state !== 'idle' || abortRef.current !== null,
						}).then((answer) => {
							// A later session keeps the operator's choice: `/model`
							// rebuilds the session, and the profile goes with it.
							if (answer.profile) browserProfileRef.current = answer.profile
							if (conversationGenRef.current !== generation) return
							pushMessage('system', answer.text)
						})
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
			const wasHeldByInterrupt = queuePauseRef.current?.source === 'operator-interrupt'
			if (mode === 'submit') advanceQueueContinuation()
			const prompt: HumanQueuedPrompt = {
				kind: 'human',
				text: outgoing,
				...(meta.source === 'composer' && !skillFlow ? { recallable: true as const } : {}),
				...(meta.source === 'composer' && !skillFlow && outgoing !== value
					? { recallText: value }
					: {}),
				...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
				...(skillFlow ? { skillFlow: true as const } : {}),
				...(armedTriggers.length > 0 && !skillFlow ? { triggers: armedTriggers } : {}),
			}
			// `/skills save` and `/skills new` are turns of their own: steered into
			// a running turn, they would lose the flag that keeps the skill-making
			// turn from being proposed as a skill, and the model would read them
			// mid-task. They wait in the queue for the turn to end.
			if (skillFlow && activeTurnInboxRef.current) {
				pushMessage('system', 'Queued: this runs when the current reply ends.')
			}
			if (mode === 'submit' && !skillFlow) {
				const inbox = activeTurnInboxRef.current
				if (inbox) {
					const expanded = expandFileMentions(outgoing, ctx.cwd)
					if (
						inbox.accept({
							prompt,
							message: createUserMessage(expanded.sendText, prompt.attachments),
							attachedFiles: expanded.attached.length,
							queuedBefore: [...queuedRef.current],
						})
					) {
						bindSteeredTriggers(armedTriggers)
						return
					}
				}
			}
			if (mode === 'submit' && wasHeldByInterrupt) replaceQueued([prompt, ...queuedRef.current])
			else enqueueQueued(prompt)
		},
		[
			activeSkills,
			advanceQueueContinuation,
			applyPermissionMode,
			bindSteeredTriggers,
			composerTriggersOn,
			spinnerTipsOn,
			tipHistory,
			conversationLearning,
			applyReasoningEffort,
			appLifetime,
			ctx.cwd,
			doResume,
			doUnarchive,
			enqueueQueued,
			exitWithSummary,
			hasUnsettledTurn,
			goalActivation,
			goalStatus,
			hostCommands,
			materializeConversation,
			nextId,
			openAgentCockpit,
			runAgentsCommand,
			abandonActiveTurn,
			pushMessage,
			rawOutput,
			rememberProjectNote,
			removeStoredCredential,
			replaceQueued,
			resetTranscript,
			runConversationExport,
			session,
			selectModelIntent,
			setChoicePicker,
			setCopyPicker,
			setReasoningEffort,
			// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
			slashCtx,
			stableExportSource,
			startFreshConversation,
			state,
			terminal.rows,
		],
	)
	// The "waiting for your input" notice (`tui.notifications` with `idle-prompt`):
	// a minute after a turn ends with nobody at the keyboard. The condition lives
	// in `IdleNotifier`; this only tells it what the screen knows.
	const idleStateRef = useRef({
		dialogOpen: false,
		session: session,
		sendNotification: sendTerminalNotification,
	})
	idleStateRef.current = {
		// The detailed transcript is the person reading: nothing is rewritten under it.
		dialogOpen:
			permission !== null ||
			textPrompt !== null ||
			choicePicker !== null ||
			phase !== 'ready' ||
			transcriptScreen,
		session,
		sendNotification: sendTerminalNotification,
	}
	const idleNotifierRef = useRef<IdleNotifier | null>(null)
	if (idleNotifierRef.current === null) {
		idleNotifierRef.current = new IdleNotifier({
			now: Date.now,
			setTimer: (run, ms) => setTimeout(run, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			lastInteractionAt: () => lastKeyAtRef.current,
			isTurnRunning: () => abortRef.current !== null,
			isDialogOpen: () => idleStateRef.current.dialogOpen,
			hasPendingWake: () =>
				queuedRef.current.length > 0 || (scheduleRef.current?.loops.list().length ?? 0) > 0,
			hasBackgroundWork: () => {
				const live = idleStateRef.current.session
				return (
					(live?.jobs?.().some((job) => job.status === 'running') ?? false) ||
					(live?.subagents
						?.getSnapshot()
						.some((agent) => ['starting', 'queued', 'working'].includes(agent.status)) ??
						false)
				)
			},
			send: () => idleStateRef.current.sendNotification({ kind: 'idle-prompt' }),
		})
	}
	useEffect(() => {
		if (state !== 'idle') idleNotifierRef.current?.turnStarted()
		if (state !== 'idle') idleCompaction.compactor.requestStarted()
	}, [state])
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change in either list is the signal; the notifier reads the live values itself.
	useEffect(() => {
		idleNotifierRef.current?.backgroundChanged()
	}, [backgroundJobs, subagents])
	useEffect(() => () => idleNotifierRef.current?.dispose(), [])
	// The away recap (`./away-recap.ts`): one line, written by the small model,
	// when the person comes back after being away from the terminal.
	const messagesLiveRef = useRef(messages)
	messagesLiveRef.current = messages
	const composerHasDraftRef = useRef(composerHasDraft)
	composerHasDraftRef.current = composerHasDraft
	const recapTurnRef = useRef<{ readonly sessionId: SessionId; readonly turnId: TurnId } | null>(
		null,
	)
	const manualRecapRef = useRef<AbortController | null>(null)
	const pushRecap = useCallback(
		(text: string) => {
			const id = nextId()
			setMessages((previous) => [
				...previous,
				{ id, role: 'system', content: text, kind: 'recap' as const },
			])
		},
		[nextId],
	)
	/** The recap text for the open conversation, or `undefined` when it cannot be had. */
	const writeRecap = useCallback(async (signal: AbortSignal): Promise<string | undefined> => {
		const sideModel = idleStateRef.current.session?.sideModel
		const sessionId = scopeRef.current?.sessionId
		if (!sideModel || !sessionId) return undefined
		// The spend is counted on the conversation's latest turn; a conversation
		// resumed in this launch with no turn yet gets a fresh one to count on.
		const turn = recapTurnRef.current
		return generateRecap({
			sideModel,
			sessionId,
			turnId: turn?.sessionId === sessionId ? turn.turnId : generateTurnId(),
			turns: recapTurns(messagesLiveRef.current),
			signal,
		})
	}, [])
	const awayRecapRef = useRef<AwayRecap | null>(null)
	if (awayRecapRef.current === null) {
		awayRecapRef.current = new AwayRecap({
			now: Date.now,
			setTimer: (run, ms) => setTimeout(run, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			focus: terminalFocus,
			enabled: () => recapOnRef.current,
			isTurnRunning: () => abortRef.current !== null,
			draftPresent: () => composerHasDraftRef.current,
			backgroundWorkPending: () =>
				idleStateRef.current.session?.subagents
					?.getSnapshot()
					.some((agent) => ['starting', 'queued', 'working'].includes(agent.status)) ?? false,
			loopScheduled: () => (scheduleRef.current?.loops.list().length ?? 0) > 0,
			rows: () => recapRows(messagesLiveRef.current),
			generate: (signal) => writeRecap(signal),
			append: pushRecap,
			waitMs: recapWaitMs(process.env),
		})
	}
	useEffect(() => {
		if (state !== 'idle') {
			awayRecapRef.current?.turnStarted()
			manualRecapRef.current?.abort()
		}
	}, [state])
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setting is the signal; the recap reads the live value itself.
	useEffect(() => {
		awayRecapRef.current?.refresh()
	}, [recapOn])
	useEffect(() => () => awayRecapRef.current?.dispose(), [])
	// Compacting a large conversation nobody is using before its one-hour prompt
	// cache lapses (`compaction.idleCompaction`). The decision lives in
	// `IdleCompactor`; this supplies what the screen knows and shows the result.
	const idleCompaction = useIdleCompaction({
		conversationKey: () =>
			`${scopeRef.current?.sessionId ?? ''}|${session?.providerSummary ?? ''}|${session?.modelSummary ?? ''}`,
		settings: () => session?.idleCompaction,
		lastInteractionAt: () => lastKeyAtRef.current,
		isTurnRunning: () => abortRef.current !== null || compactingRef.current,
		isDialogOpen: () => idleStateRef.current.dialogOpen,
		hasPendingWake: () =>
			queuedRef.current.length > 0 || (scheduleRef.current?.loops.list().length ?? 0) > 0,
		hasBackgroundWork: () => {
			const live = idleStateRef.current.session
			return (
				(live?.jobs?.().some((job) => job.status === 'running') ?? false) ||
				(live?.subagents
					?.getSnapshot()
					.some((agent) => ['starting', 'queued', 'working'].includes(agent.status)) ??
					false)
			)
		},
		compact: async () => {
			const live = idleStateRef.current.session
			if (!live || compactingRef.current) return false
			compactingRef.current = true
			setCompacting(true)
			try {
				const result = await live.compact(modelHistoryRef.current, undefined, 'idle')
				if (!result) return false
				modelHistoryRef.current = [...result.messages]
				// The size of the new context is not known until the next reply.
				idleCompaction.contextTokens.current = undefined
				setContextHidden(true)
				const keptTurns = result.messages.filter(
					(m) => m.role === 'user' || m.role === 'assistant',
				).length
				resetTranscript()
				setMessages((prev) => keepRecentRows(prev, keptTurns))
				pushSystem('notice', IDLE_COMPACTION_NOTICE)
				setCompactionTally((tally) => ({
					...tally,
					passes: tally.passes + 1,
					summaries: tally.summaries + 1,
				}))
				return true
			} finally {
				compactingRef.current = false
				setCompacting(false)
			}
		},
	})
	idleCompactionRef.current = idleCompaction
	// A permission or a question waiting on the person: the notice countdown
	// ends when none is left, and the turn's "Worked for" leaves the wait out.
	const awaitingPerson =
		permission !== null ||
		questionDialog !== null ||
		planPrompt !== null ||
		scheduleReviewPrompt !== null ||
		(choicePicker !== null && choicePicker.kind === 'user-question')
	useEffect(() => {
		if (awaitingPerson) pauseClockRef.current.begin(Date.now())
		else pauseClockRef.current.end(Date.now())
	}, [awaitingPerson])
	useEffect(() => {
		if (
			permission === null &&
			questionDialog === null &&
			choicePicker === null &&
			planPrompt === null &&
			scheduleReviewPrompt === null &&
			saveSkillPrompt === null
		)
			approvalNotifierRef.current?.dialogClosed()
	}, [permission, questionDialog, choicePicker, planPrompt, scheduleReviewPrompt, saveSkillPrompt])
	// `--resume` without a title that names one conversation: the picker, opened
	// once, as if `/resume` had been typed. The ref is spent before the call.
	const launchResumePickerRef = useRef(initialCtx.openResumePicker)
	useEffect(() => {
		const request = launchResumePickerRef.current
		if (request === undefined) return
		if (phase !== 'ready' || state !== 'idle' || permission !== null || textPrompt !== null) return
		launchResumePickerRef.current = undefined
		void doResume(request.query)
	}, [phase, state, permission, textPrompt, doResume])
	// `--message`: the launch's first message, sent once the session can take it. The ref is
	// spent before the call, so neither a re-render, a resume nor a reload can send it twice.
	const launchMessageRef = useRef(initialCtx.launchSettings?.message)
	useEffect(() => {
		const message = launchMessageRef.current
		if (message === undefined) return
		if (
			phase !== 'ready' ||
			state !== 'idle' ||
			!session?.hasProvider ||
			permission !== null ||
			textPrompt !== null ||
			choicePicker !== null
		)
			return
		launchMessageRef.current = undefined
		handleSubmit(message.trim(), undefined, 'submit', {
			source: 'launch-message',
		})
	}, [phase, state, session, permission, textPrompt, choicePicker, handleSubmit])
	// `applyChoiceSelection` is declared before `handleSubmit` because the
	// picker is also used by review/export flows. Keep only this dispatch hop in
	// a ref so selecting a help row re-enters the one ordinary slash-command
	// path instead of growing a second command executor.
	commandPickerSubmitRef.current = (command) =>
		handleSubmit(command, undefined, 'submit', { source: 'command-picker' })
	// A turn's after-turn triggers, when it ends. Save as skill runs exactly the
	// prompt `/skills save` sends, at the front of the queue, only when the
	// turn completed, did tool work, did not already save a skill, and saving
	// is still possible now. Otherwise one row says why, and `/skills save`
	// still works. Returns whether the turn had one, so the proposal to save
	// it is not also printed.
	triggerFollowUpsRef.current = (st, ending) => {
		const followUps = st.followUps ?? []
		st.followUps = []
		if (!followUps.includes('save-skill')) return false
		const reason =
			ending === 'cancelled'
				? 'the reply was cancelled'
				: ending === 'failed'
					? 'the reply failed'
					: ending === 'paused'
						? 'the reply paused'
						: ending === 'stopped'
							? 'the reply stopped before it finished'
							: !st.learning || st.learning.steps < 1
								? 'the reply did no tool work'
								: st.learning.savedSkill
									? 'the reply already saved a skill'
									: triggerUnavailable('save-skill', triggerContextNow())
		if (reason) {
			pushSystem(
				'notice',
				`Namzu did not offer to save a skill: ${reason}. /skills save saves one anyway.`,
			)
			return true
		}
		// The proposal was taken up, as `/skills save` records it.
		conversationLearning().proposed = true
		const home = resolveNamzuHome()
		const ledger = readSuggestionLedger(home)
		if (ledger.unanswered > 0) writeSuggestionLedger(home, { ...ledger, unanswered: 0 })
		replaceQueued([
			{ kind: 'human', text: learnSkillPrompt(), skillFlow: true },
			...queuedRef.current,
		])
		pushSystem('notice', 'Saving a skill from this reply.')
		return true
	}
	saveSkillNotifyRef.current = () => announceApproval()
	scheduleLiveRef.current = {
		...(scheduleLiveRef.current?.model ? { model: scheduleLiveRef.current.model } : {}),
		say: (text) => {
			closeLiveReply()
			pushMessage('system', text)
		},
		ask: askQuestion,
		review: reviewSchedule,
		askPermission: onPermission,
		submit: (text, createdBy) =>
			handleSubmit(text, undefined, 'submit', {
				source: createdBy === 'operator' ? 'operator-loop' : 'model-loop',
			}),
	}
	const pollSourceDeliveries = useCallback(() => {
		if (appLifetime.signal.aborted) return
		const sessions = sessionsRef.current
		const scope = scopeRef.current
		const source = sourceConversationBinding(sessions, scope, conversationMaterializedRef.current)
		if (!sessions?.root || !source) return
		const generation = conversationGenRef.current
		void sourceDeliveryViewRef.current
			?.poll(schedulePaths(sessions.root), source, generation)
			.then((deliveries) => {
				if (
					appLifetime.signal.aborted ||
					conversationGenRef.current !== generation ||
					sessionsRef.current !== sessions ||
					!conversationMaterializedRef.current ||
					scopeRef.current?.sessionId !== source.sessionId ||
					scopeRef.current?.projectId !== source.projectId ||
					scopeRef.current?.tenantId !== source.tenantId
				)
					return
				sourceDeliveryIssueRef.current = null
				for (const delivery of deliveries)
					pushMessage(
						'system',
						sourceDeliveryLine(delivery),
						false,
						SYSTEM_ROW_GLYPH,
						undefined,
						systemRowStyle(deliveryLevel(delivery.status)).color,
						undefined,
						undefined,
						true,
					)
				// A startup inbox may have more than one page. Yield to Ink between
				// bounded batches, then continue without waiting for the timer.
				if (deliveries.length > 0 && sourceDeliveryViewRef.current?.hasMore)
					setImmediate(() => sourceDeliveryPollRef.current())
			})
			.catch((error) => {
				if (
					appLifetime.signal.aborted ||
					conversationGenRef.current !== generation ||
					sessionsRef.current !== sessions ||
					!conversationMaterializedRef.current ||
					scopeRef.current?.sessionId !== source.sessionId ||
					scopeRef.current?.projectId !== source.projectId ||
					scopeRef.current?.tenantId !== source.tenantId
				)
					return
				const key = JSON.stringify([generation, source])
				if (sourceDeliveryIssueRef.current === key) return
				sourceDeliveryIssueRef.current = key
				pushSystem('warning', sourceDeliveryReadError(error))
			})
	}, [appLifetime.signal, pushMessage, pushSystem])
	sourceDeliveryPollRef.current = pollSourceDeliveries
	useEffect(() => {
		pollSourceDeliveries()
		const timer = setInterval(pollSourceDeliveries, 15_000)
		return () => clearInterval(timer)
	}, [pollSourceDeliveries])
	// Scheduled work since the TUI last looked: one line, after the first
	// paint, never blocking it. Loops fire when a turn ends, and on their timer.
	useEffect(() => {
		const timer = setTimeout(() => {
			if (palDefinitionRef.current) return
			const line = scheduleRef.current?.startupLine()
			if (line) scheduleLiveRef.current?.say(line)
		}, 250)
		return () => {
			clearTimeout(timer)
			scheduleRef.current?.dispose()
		}
	}, [])
	useEffect(() => {
		if (state !== 'idle' || palDefinitionRef.current) return
		try {
			scheduleRef.current?.loops.tick()
		} catch {
			// A loop that cannot be read never takes the screen down with it.
		}
	}, [state])

	// Keep the footer on the same durable goal record the driver mutates. A ref
	// alone cannot repaint React, so every goal mutation bumps goalDriveVersion;
	// generation/session checks stop a late disk read labelling a resumed chat.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
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
				if (
					pendingGoalResumeRef.current === sessionId &&
					phase === 'ready' &&
					!choicePickerRef.current
				) {
					pendingGoalResumeRef.current = null
					if (goal && (goal.phase === 'active' || goal.phase === 'paused')) {
						setSelectedChoice(0)
						setChoicePicker({
							kind: 'resume-goal',
							title: 'Continue the saved goal?',
							notice: goal.objective,
							sessionId,
							values: ['resume', 'later'],
							options: [
								{
									label: 'Resume goal',
									description: 'Continue automatic work toward this objective.',
								},
								{
									label: 'Not now',
									description: 'Keep automatic work stopped; resume later with /goal resume.',
								},
							],
						})
					}
				}
			})
			.catch(() => {
				if (!disposed && conversationGenRef.current === generation) setGoalStatus(null)
			})
		return () => {
			disposed = true
		}
	}, [goalDriveVersion, phase, session, setChoicePicker])

	// Admit automatic work only at a whole-App durable boundary. This effect
	// reserves; it never starts a turn itself. The one queue pump below remains
	// the sole starter, which is what keeps a human prompt that arrives during
	// admission ahead of the resulting goal round.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
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
			pendingModelSwitchRef.current ||
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
		if (!durableSessions || !scope || !conversationMaterializedRef.current) return
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
					pendingModelSwitchRef.current ||
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
					pendingModelSwitchRef.current ||
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
						`${explainFailure(error, 'Automatic goal continuation stopped.')} Run /goal resume to try again.`,
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
		modelSwitchVersion,
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => {
		if (
			state !== 'idle' ||
			phase !== 'ready' ||
			queuedRef.current.length === 0 ||
			queuePauseRef.current !== null ||
			abortRef.current ||
			hasUnsettledTurn() ||
			pendingModelSwitchRef.current ||
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
		queueSettleVersion,
		modelSwitchVersion,
		queuePause,
		textPrompt,
		choicePicker,
		copyPicker,
		dequeueQueued,
		hasUnsettledTurn,
		runTurn,
	])

	useEffect(() => {
		if (
			phase !== 'ready' ||
			palDefinitionRef.current ||
			peersRef.current ||
			peersStartingRef.current
		)
			return
		peersStartingRef.current = true
		let disposed = false
		let opened: LivePeers | null = null
		const onClose = () => {
			disposed = true
			if (peersRef.current === opened) peersRef.current = null
			void opened?.close()
		}
		appLifetime.signal.addEventListener('abort', onClose, { once: true })
		void openLivePeers({
			home: sessionsRef.current?.root ?? resolveNamzuHome(),
			cwd: sessionsRef.current?.projectRoot ?? ctxRef.current.cwd,
			version: ctxRef.current.version,
			mode: () => permissionModeRef.current,
			state: () =>
				permissionResolveRef.current
					? 'awaiting-permission'
					: stateRef.current === 'idle'
						? 'idle'
						: 'busy',
			owner: () => conversationGenRef.current,
			ready: () =>
				!appLifetime.signal.aborted &&
				phaseRef.current === 'ready' &&
				previousSessionRef.current?.hasProvider === true &&
				!conversationMutationRef.current,
			available: () => {
				activeTurnInboxRef.current?.notify()
				wakePeers((version) => version + 1)
			},
			report: (text) => pushMessage('system', text),
		})
			.then((peers) => {
				peersStartingRef.current = false
				opened = peers
				if (disposed) {
					void peers.close()
					return
				}
				peersRef.current = peers
				wakePeers((version) => version + 1)
			})
			.catch((error) => {
				peersStartingRef.current = false
				appLifetime.signal.removeEventListener('abort', onClose)
				if (!disposed) pushSystem('error', explainFailure(error, 'Peer messaging unavailable.'))
			})
	}, [phase, appLifetime.signal, pushMessage, pushSystem])

	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => {
		const peers = peersRef.current
		peers?.publish()
		if (
			!peers?.enabled ||
			phase !== 'ready' ||
			state !== 'idle' ||
			abortRef.current ||
			hasUnsettledTurn() ||
			queuePauseRef.current ||
			pendingModelSwitchRef.current ||
			conversationMutationRef.current ||
			textPromptRef.current ||
			choicePickerRef.current ||
			copyPickerRef.current ||
			exportingRef.current ||
			compactingRef.current ||
			goalCommandInFlightRef.current
		)
			return
		const generation = conversationGenRef.current
		const mail = peers.peek(generation)[0]
		if (
			mail &&
			!queuedRef.current.some((prompt) => prompt.kind === 'peer' && prompt.mail.id === mail.id)
		)
			enqueueQueued({
				kind: 'peer',
				text: peerMailMessage(mail).content as string,
				mail,
				generation,
			})
	}, [
		phase,
		state,
		peerVersion,
		permissionMode,
		conversationMutation,
		queueSettleVersion,
		modelSwitchVersion,
		queuePause,
		textPrompt,
		choicePicker,
		copyPicker,
		enqueueQueued,
		hasUnsettledTurn,
	])

	// What ended while nobody was talking to the model (a workflow run, a
	// background command) wakes it: an idle session starts a turn that carries the
	// one message, so the model reports without the person typing. A running turn
	// takes it at its next request boundary instead (`inboundMessages`).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `noticeVersion` is what moves; the effect reads the refs it mirrors.
	useEffect(() => {
		if (
			phase !== 'ready' ||
			state !== 'idle' ||
			abortRef.current ||
			hasUnsettledTurn() ||
			queuePauseRef.current ||
			pendingModelSwitchRef.current ||
			conversationMutationRef.current ||
			textPromptRef.current ||
			choicePickerRef.current ||
			copyPickerRef.current ||
			exportingRef.current ||
			compactingRef.current ||
			goalCommandInFlightRef.current ||
			queuedRef.current.some((prompt) => prompt.kind === 'notice')
		)
			return
		const jobs = idleJobNoticesRef.current
		const waiting =
			workflowNoticesRef.current.size > 0 ||
			childMessagesRef.current.size > 0 ||
			(jobs.ownerSession === session &&
				[...jobs.pending.keys()].some((id) => wakeJobIdsRef.current.has(id))) ||
			session?.monitors?.wakes() === true
		if (!waiting) return
		enqueueQueued({
			kind: 'notice',
			text: 'Something finished while you were idle.',
			generation: conversationGenRef.current,
		})
	}, [
		phase,
		state,
		noticeVersion,
		permissionMode,
		conversationMutation,
		queueSettleVersion,
		modelSwitchVersion,
		queuePause,
		textPrompt,
		choicePicker,
		copyPicker,
		enqueueQueued,
		hasUnsettledTurn,
		session,
	])

	// One-shot update check on launch.
	// Best-effort; surfaces a single notice when something newer is out.
	const updateCheckedRef = useRef(false)
	const [updateNotice, setUpdateNotice] = useState<ReturnType<typeof updateAmbient> | null>(null)
	useEffect(() => {
		if (phase !== 'ready' || updateCheckedRef.current) return
		updateCheckedRef.current = true
		void checkUpdates(ctx.version).then((ups) => {
			if (ups.length === 0) return
			const first = ups[0]
			if (first) setUpdateNotice(updateAmbient(first))
		})
	}, [phase, ctx.version])

	const hydrateFromPicker = useCallback(
		async (
			prefs: Preferences,
			detectedNow: readonly DetectedProvider[],
			signal: AbortSignal,
			options: {
				readonly revealAllOnFailure?: boolean
				readonly persistSelection?: boolean
				readonly chooseReasoningEffort?: boolean
				readonly auto?: boolean
			} = {},
		): Promise<boolean> => {
			try {
				await hydrateSession(prefs, detectedNow, {
					signal,
					persistSelection: options.persistSelection,
					announce: true,
					chooseReasoningEffort: options.chooseReasoningEffort,
					...(options.auto !== undefined ? { auto: options.auto } : {}),
				})
				return !signal.aborted
			} catch (err) {
				// A superseded choice no longer owns even its failure message. Its
				// eventual session object is disposed inside `hydrateSession`; a live
				// choice stays on the picker with the actionable construction error.
				if (signal.aborted) return false
				if (options.revealAllOnFailure) {
					setPickerDetected(null)
					setPickerSelectionKind('provider-and-model')
					setPickerInitialView('providers')
				}
				// A construction refusal is already a sentence for a person
				// (`StartupRefusal`); anything else is described, never pasted.
				setPickerNotice(explainFailure(err, 'Could not start the selected provider.'))
				return false
			}
		},
		[hydrateSession],
	)

	/** A typed Google API key is saved only after its provider session opens. */
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
			// Supplying a credential changes the primary's access, not unrelated
			// fallbacks, model pins, delegation or capability preferences.
			const saved = savedPrefsRef.current
			const prefs: Preferences =
				saved && primaryProvider(saved).id === credential.entry.id
					? saved
					: selectPrimaryProvider(saved, {
							id: credential.entry.id as ProviderId,
						})
			void (async () => {
				const started = await hydrateFromPicker(prefs, next, signal)
				if (!started || credential.entry.id !== 'google') return
				let path: string
				try {
					path = writeStoredGoogleApiKey(credential.apiKey ?? '')
				} catch (error) {
					pushMessage(
						'system',
						`${explainFailure(error, 'Gemini is connected, but its API key could not be saved privately.')} It is usable only until you quit Namzu.`,
					)
					return
				}
				setDetected((current) =>
					current.map((provider) =>
						provider.entry.id === 'google' &&
						provider.source.kind === 'session' &&
						provider.apiKey === credential.apiKey
							? { ...provider, source: { kind: 'stored-gemini-key', path } }
							: provider,
					),
				)
				try {
					writePreferences(prefs)
				} catch (error) {
					const couldNot = `Your Gemini API key was saved at ${homePath(path)}, but your provider choice could not be saved.`
					pushMessage(
						'system',
						`${explainFailure(error, couldNot)} Run /logout gemini to remove the key.`,
					)
					return
				}
				pushMessage(
					'system',
					`Gemini API key saved privately at ${homePath(path)} for future launches. Run /logout gemini to remove it.`,
				)
			})()
		},
		[detected, hydrateFromPicker, pushMessage],
	)

	const handlePickerSubmit = useCallback(
		(selection: { provider: string; model?: string }, signal: AbortSignal) => {
			const prefs = selectPrimaryProvider(savedPrefsRef.current, {
				id: selection.provider as ProviderId,
				...(selection.model !== undefined ? { model: selection.model } : {}),
			})
			setKeyEntryFor(null)
			setPickerNotice(null)
			// Keep a narrowed signed-in roster stable while construction is pending.
			// Only a real refusal broadens back to the general, sign-in-capable picker.
			void hydrateFromPicker(prefs, detected, signal, {
				auto: false,
				revealAllOnFailure: true,
				chooseReasoningEffort: selection.model !== undefined,
				persistSelection:
					detected.find((provider) => provider.entry.id === selection.provider)?.source.kind !==
					'session',
			})
		},
		[detected, hydrateFromPicker],
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
	/** Auto picked from the model step: leave the picker, then rebuild so the next turn routes. */
	const handlePickerAuto = useCallback(() => {
		setPickerInitialView('providers')
		setPickerDetected(null)
		setPickerSelectionKind('provider-and-model')
		setPhase('ready')
		void selectModelIntent('auto', { fromPicker: true })
	}, [selectModelIntent])

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
			lastKeyAtRef.current = Date.now()
			terminalFocus.noteInput()
			if (transcriptScreen || (scrollOpen && permission === null)) return
			// The save-skill screen owns its keys, Esc and Ctrl+C included: neither
			// may interrupt the turn that is waiting on its answer. A permission
			// request (an agent's, say) takes the screen over it and gets the keys.
			if (
				(saveSkillPromptRef.current ||
					planPromptRef.current ||
					questionDialogRef.current ||
					scheduleReviewPromptRef.current) &&
				permission === null
			)
				return
			// Startup has refused admission, so there is no draft or active turn to
			// protect with the ready screen's two-press exit ladder.
			if (phase === 'unhealthy') {
				if (key.escape || (key.ctrl && input === 'c')) exitWithSummary()
				return
			}
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
			// The rewind dialog owns the keyboard while open.
			if (phase === 'edit') {
				if (editCommittedRef.current) return
				const view = rewindRef.current
				const closeRewind = () => {
					rewindGenRef.current += 1
					setEditList([])
					setRewindView(null)
					setPhase('ready')
				}
				if (!view) {
					closeRewind()
					return
				}
				if (key.ctrl && input === 'c' && !view.state.busy) {
					closeRewind()
					return
				}
				const step = rewindKey(view.state, input, key, {
					rows: view.rows,
					canSummarize: Boolean(session?.compactRange),
				})
				if (step.effect?.kind === 'close') {
					closeRewind()
					return
				}
				if (step.state !== view.state) setRewindView({ ...view, state: step.state })
				if (step.effect?.kind === 'choose') {
					void runRewindChoice(step.effect.row, step.effect.option, step.effect.context)
				}
				return
			}
			// Resume picker owns the keyboard while open.
			if (phase === 'resume' || phase === 'unarchive') {
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
							key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
						),
					)
				} else if (key.upArrow)
					setSelectedResume((index) => moveSelection(index, resumeList.length, 'previous'))
				else if (key.downArrow)
					setSelectedResume((index) => moveSelection(index, resumeList.length, 'next'))
				else if (key.return) {
					const conv = resumeList[selectedResumeRef.current]
					if (conv)
						void (phase === 'unarchive'
							? restoreArchivedConversation(conv)
							: resumeConversation(conv))
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
				// The focus rests on the exit choice, so a deliberate Enter exits. It
				// can only leave: the in-flight Enter above is still ignored, and
				// nothing here grants trust.
				else if (key.return) exitWithSummary()
				return
			}
			// A pending permission prompt owns the keyboard: y/n/a decide it.
			if (permissionResolveRef.current) {
				const ch = input.toLowerCase()
				// A refusal being typed owns the keys until it is sent or put away.
				// Sending it is a refusal, so it is never held back by the settle window.
				const typing = permissionReasonRef.current
				if (typing !== null) {
					if (key.ctrl && input === 'c') {
						interruptTurn()
						return
					}
					if (key.escape) {
						setPermissionReason(null)
						return
					}
					if (key.return) {
						const refusal = noWithReason(typing)
						if (refusal) resolvePermission(refusal)
						return
					}
					if (key.backspace || key.delete) {
						setPermissionReason(Array.from(typing).slice(0, -1).join(''))
						return
					}
					if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) {
						setPermissionReason(appendTypedReason(typing, input))
					}
					return
				}
				if (permission && ch === 'd') {
					setPermissionReviewOffset(0)
					setPermissionDetailsOpen(!permissionDetailsOpenRef.current)
					return
				}
				if (permission && (key.upArrow || key.downArrow)) {
					const current = permissionChoiceRef.current
					const last =
						permissionAnswers(permission.toolCalls, permissionAnswerOptions(permission)).length - 1
					const next = key.upArrow ? Math.max(0, current - 1) : Math.min(last, current + 1)
					setPermissionChoice(next as PermissionChoice)
					return
				}
				if (permission && (key.pageUp || key.pageDown || key.home || key.end)) {
					const source = permissionDetailsOpenRef.current
						? permission.review
						: (permission.summary.compactText ?? permission.summary.text)
					const count = permissionReviewRows(source, terminal.columns).length
					const pageRows = Math.max(1, permissionReviewPageRows(terminal.rows))
					const maxOffset = Math.max(0, count - pageRows)
					const current = Math.min(permissionReviewOffsetRef.current, maxOffset)
					const next = key.home
						? 0
						: key.end
							? maxOffset
							: key.pageUp
								? Math.max(0, current - pageRows)
								: Math.min(maxOffset, current + pageRows)
					setPermissionReviewOffset(next)
					return
				}
				// Refusing is never deferred or gated — it is the direction a
				// mistake is recoverable in, so it answers on the first press.
				if (key.ctrl && input === 'c') {
					// At a question of the person's own turn, Ctrl+C ends like a plain No:
					// the kernel settles every call and the turn closes with one row.
					if (permission && endsTurnOnNo(permission)) {
						resolvePermission(plainNo(true))
						return
					}
					interruptWithRow(false)
					return
				}
				const noDecision = permission ? plainNo(endsTurnOnNo(permission)) : plainNo(false)
				if (ch === 'n' || key.escape) {
					// The person's own No is recorded as theirs, so the step reads "You declined
					// this" and not the refusal text the model was given.
					resolvePermission(noDecision)
					return
				}
				const answers = permission
					? permissionAnswers(permission.toolCalls, permissionAnswerOptions(permission))
					: []
				// Tab on the No row opens the person's own words for this one call.
				if (key.tab && !key.shift) {
					if (answers[permissionChoiceRef.current]?.kind === 'reject') setPermissionReason('')
					return
				}
				// Every approval waits out the settle window: `y`, `a`, a digit and
				// Enter alike. Enter confirms the answer the cursor is on, which
				// opens on "Yes" — the prompt an operator knows from elsewhere — so
				// the window is what stands between an in-flight Enter and a call
				// the operator never looked at. Refusals above never wait.
				if (!approvalIsDeliberate(permissionOpenedAtRef.current, Date.now())) return
				// The answers on screen, so a digit or Enter means what it is next
				// to: a batch-only prompt (a scheduled run) has no "allow all", and
				// neither its `a` nor a `3` answers it.
				const numbered = /^[1-9]$/.test(ch) ? Number(ch) - 1 : null
				const chosen = key.return ? permissionChoiceRef.current : numbered
				// Shift+Tab is the "accept edits" answer where one is offered.
				const answer =
					key.tab && key.shift
						? answers.find((candidate) => candidate.kind === 'approve-edits')
						: ch === 'y'
							? answers[0]
							: chosen !== null
								? answers[chosen]
								: undefined
				if (!answer) return
				if (answer.kind === 'reject') {
					resolvePermission(noDecision)
					return
				}
				// The extra answers are session settings applied the way their own
				// commands apply them, then this question is approved like any yes.
				// The change is then announced, so every question still open is
				// re-checked against it.
				if (answer.kind === 'approve-edits') applyPermissionMode('accept-edits', false)
				else if (answer.kind === 'approve-rule' && answer.allows) {
					const notice = session?.allowForSession?.(answer.allows)
					if (notice) pushMessage('system', notice)
				}
				resolvePermission({ kind: 'approve' })
				if (answer.kind === 'approve-rule') rulesChanged(answer.allows)
				return
			}
			// The shell view observes only this AgentSession's jobs. Consent always
			// takes precedence above; the composer stays mounted but hidden below.
			const shellView = jobSurfaceRef.current
			if (shellView) {
				if (shellView.ownerSession !== session) {
					setJobSurface(null)
					return
				}
				// The Return that submitted /jobs must not also inspect or stop a
				// row before the new screen has painted.
				if (jobSurfaceCommittedRef.current !== shellView) return
				if ((key.ctrl && input === 'c') || input.toLowerCase() === 'q') {
					setJobSurface(null)
					return
				}
				if (key.escape) {
					setJobSurface(
						shellView.detailJobId ? { ...shellView, detailJobId: null, tailOffset: 0 } : null,
					)
					return
				}
				const selectedId = shellView.detailJobId ?? shellView.selectedJobId ?? backgroundJobs[0]?.id
				const selectedJob = backgroundJobs.find((job) => job.id === selectedId)
				if (
					input.toLowerCase() === 'x' &&
					selectedJob?.status === 'running' &&
					session?.stopJob &&
					!shellView.busyJobId
				) {
					const owner = session
					const stopJob = owner.stopJob
					if (!stopJob) return
					setJobSurface({
						...shellView,
						busyJobId: selectedJob.id,
						notice: undefined,
					})
					void stopJob(selectedJob.id).then(
						(result) => {
							if (previousSessionRef.current !== owner) return
							setJobSnapshot({
								ownerSession: owner,
								jobs: owner.jobs?.() ?? [],
							})
							const current = jobSurfaceRef.current
							if (current?.busyJobId === selectedJob.id)
								setJobSurface({
									...current,
									busyJobId: undefined,
									notice:
										result.status === 'killed'
											? 'Stopped.'
											: result.status === 'exited'
												? `Already finished (exit code ${result.exitCode ?? '?'}).`
												: 'The stop request did not finish.',
								})
						},
						(error) => {
							if (previousSessionRef.current !== owner) return
							const current = jobSurfaceRef.current
							if (current?.busyJobId === selectedJob.id)
								setJobSurface({
									...current,
									busyJobId: undefined,
									notice: explainFailure(error, 'Could not stop the command.'),
								})
						},
					)
					return
				}
				if (shellView.detailJobId) {
					let output: BackgroundJobOutput | undefined
					try {
						output = session?.readJob?.(shellView.detailJobId)
					} catch {
						output = undefined
					}
					const max = maxBackgroundJobTailOffset(
						output,
						terminal.rows,
						Math.max(1, terminal.columns - 2),
					)
					const page = backgroundJobOutputPageSize(terminal.rows)
					const offset = Math.min(shellView.tailOffset, max)
					const next =
						key.home || input === 'g'
							? max
							: key.end || input === 'G'
								? 0
								: key.pageUp
									? Math.min(max, offset + page)
									: key.pageDown
										? Math.max(0, offset - page)
										: key.upArrow
											? Math.min(max, offset + 1)
											: key.downArrow
												? Math.max(0, offset - 1)
												: null
					if (next !== null)
						setJobSurface({
							...shellView,
							tailOffset: next,
							notice: undefined,
						})
					return
				}
				if (key.return && selectedJob) {
					setJobSurface({
						...shellView,
						selectedJobId: selectedJob.id,
						detailJobId: selectedJob.id,
						tailOffset: 0,
						notice: undefined,
					})
					return
				}
				if (key.home || key.end || key.pageUp || key.pageDown || key.upArrow || key.downArrow) {
					const current = Math.max(
						0,
						backgroundJobs.findIndex((job) => job.id === shellView.selectedJobId),
					)
					const page = backgroundJobsPageSize(terminal.rows)
					const next = key.home
						? 0
						: key.end
							? backgroundJobs.length - 1
							: key.pageUp
								? Math.max(0, current - page)
								: key.pageDown
									? Math.min(backgroundJobs.length - 1, current + page)
									: key.upArrow
										? Math.max(0, current - 1)
										: Math.min(backgroundJobs.length - 1, current + 1)
					const job = backgroundJobs[next]
					if (job)
						setJobSurface({
							...shellView,
							selectedJobId: job.id,
							notice: undefined,
						})
				}
				return
			}
			// The active child count already advertises this key beside Working.
			// Open the same retained cockpit as `/agent`; Enter then drills into a
			// child's transcript. Keep the shortcut below consent so it can never
			// hide an approval that owns the keyboard.
			// The agents rail owns the arrows, Enter, x and Esc while it is focused.
			// Any other key hands the keyboard back to the composer.
			const railTarget = railFocusRef.current
			if (railTarget !== null && railJustFocusedRef.current) return
			if (railTarget !== null) {
				const rows = railRowsRef.current
				const flows = railWorkflowsRef.current
				const chordPending = railChordRef.current
				railChordRef.current = false
				// `main` (only beside agent rows), then the agents, then the workflows:
				// the order they are drawn in.
				const ids = [
					...(shellCountRef.current > 0 ? [SHELLS_FOCUS] : []),
					...(railShowsMain(rows.length, viewingAgentRef.current) ? ['main'] : []),
					...rows.map((agent) => agent.viewId),
					...flows.map((f) => f.focusId),
				]
				const at = Math.max(0, ids.indexOf(railTarget))
				const selected = rows.find((agent) => agent.viewId === railTarget)
				const selectedWorkflow = flows.find((flow) => flow.focusId === railTarget)
				if (
					ids.length === 0 ||
					(ids.length === 1 && ids[0] === 'main' && viewingAgentRef.current === null) ||
					(agentSurfaceRef.current && viewingAgentRef.current === null)
				) {
					setRailFocus(null)
				} else if (key.escape) {
					setRailFocus(null)
					return
				} else if (key.ctrl && input === 'x') {
					railChordRef.current = true
					return
				} else if (key.ctrl && input === 'k' && chordPending) {
					// Background agents only; workflows are stopped one at a time with `x`.
					requestStopAllAgents()
					return
				} else if (key.upArrow || key.downArrow) {
					const index = at + (key.downArrow ? 1 : -1)
					setRailFocus(ids[Math.max(0, Math.min(ids.length - 1, index))] ?? ids[0] ?? null)
					return
				} else if (key.return) {
					setRailFocus(null)
					if (railTarget === 'main') {
						// `main` is the way back from a viewed agent to the conversation.
						if (viewingAgentRef.current !== null) setAgentSurface(null)
					} else if (railTarget === SHELLS_FOCUS) {
						openShellJobs()
					} else if (selectedWorkflow) {
						openWorkflowFromRail(selectedWorkflow.id, selectedWorkflow.focusId)
					} else if (selected) {
						setAgentSurface({
							kind: 'transcript',
							selectedPhaseId: selected.phaseId,
							selectedId: selected.viewId,
							returnFocus: 'agents',
							tailOffset: 0,
							fromRail: true,
						})
					}
					return
				} else if (input === 'x' && !key.ctrl && !key.meta) {
					if (selectedWorkflow) {
						if (railWorkflowActionFor(selectedWorkflow) === 'stop') {
							if (selectedWorkflow.runId !== undefined) {
								// A run is stopped as a whole: queued agents never start.
								session?.workflows?.stop(selectedWorkflow.runId)
								return
							}
							// Every member still going is stopped the way `x` on its own
							// row would; the row settles by itself as they report their end.
							for (const member of selectedWorkflow.agents) {
								if (!['completed', 'failed', 'cancelled'].includes(member.status)) {
									session?.stopSubagent?.(member.viewId)
								}
							}
						} else {
							setDismissedAgents((current) => new Set(current).add(selectedWorkflow.focusId))
							setRailFocus(ids[at + 1] ?? ids[at - 1] ?? null)
						}
						return
					}
					if (!selected) return
					if (railActionFor(selected) === 'stop') {
						// The row turns into a finished one by itself once the child
						// reports its end; nothing else to update here.
						session?.stopSubagent?.(selected.viewId)
					} else {
						setDismissedAgents((current) => new Set(current).add(selected.viewId))
						setRailFocus(ids[at + 1] ?? ids[at - 1] ?? null)
					}
					return
				} else {
					setRailFocus(null)
				}
			}
			if (key.ctrl && input === 't') {
				if (agentSurfaceRef.current) {
					setAgentSurface(null)
					return
				}
				if (openCockpitFromCurrentRows()) {
					void hydrateSavedChildren()
					return
				}
				// Nothing on screen yet. The conversation's children may exist only
				// as saved evidence, so the request outlives that read rather than
				// being answered by an empty snapshot.
				void openAgentCockpit()
			}
			// Child observation owns navigation, but never outranks consent: the
			// permission branch above preempts it if a child or parent call asks.
			const agentView = agentSurfaceRef.current
			if (agentView) {
				// The Return that opened `/agent` cannot also drill into the
				// highlighted child before the list has appeared on screen.
				if (agentSurfaceCommittedRef.current !== agentView) return
				const agents = subagentsRef.current
				if (agentView.kind === 'cockpit') {
					const workflows = agentWorkflows(agents, workflowRunsRef.current)
					const workflowIndex = Math.max(
						0,
						workflows.findIndex((workflow) =>
							workflow.phases.some((phase) => phase.id === agentView.selectedPhaseId),
						),
					)
					const workflow = workflows[workflowIndex]
					const phases = workflow?.phases ?? []
					const phaseIndex = Math.max(
						0,
						phases.findIndex((phase) => phase.id === agentView.selectedPhaseId),
					)
					const phase = phases[phaseIndex]
					const phaseAgents = phase?.agents ?? []
					const agentIndex = Math.max(
						0,
						phaseAgents.findIndex((agent) => agent.viewId === agentView.selectedId),
					)
					const selected = phaseAgents[agentIndex]
					// A phase a workflow declared that nothing has started in has no
					// agent: it can be looked at, not drilled into.
					if (!phase || (!selected && workflow?.runId === undefined)) {
						setAgentSurface(null)
						return
					}
					const hasPhaseLevel = workflow ? cockpitEntryFocus(workflow) === 'phases' : false
					if ((key.ctrl && input === 'c') || input.toLowerCase() === 'q') {
						setAgentSurface(null)
						return
					}
					if (key.escape) {
						if (agentView.railReturn !== undefined) {
							// Opened from a workflow row: one step up inside the workflow,
							// then back to the row — never out to the list of workflows.
							if (agentView.focus === 'agents' && hasPhaseLevel) {
								setAgentSurface({ ...agentView, focus: 'phases' })
								return
							}
							setAgentSurface(null)
							setRailFocus(agentView.railReturn)
							return
						}
						if (agentView.focus === 'agents' && hasPhaseLevel) {
							setAgentSurface({ ...agentView, focus: 'phases' })
							return
						}
						setAgentSurface(
							workflows.length > 1 && agentView.focus !== 'workflows'
								? { ...agentView, focus: 'workflows' }
								: null,
						)
						return
					}
					// Left walks one level up, as Esc does.
					if (key.leftArrow) {
						if (agentView.focus === 'agents' && hasPhaseLevel) {
							setAgentSurface({ ...agentView, focus: 'phases' })
						} else if (agentView.focus !== 'workflows') {
							if (agentView.railReturn !== undefined) {
								setAgentSurface(null)
								setRailFocus(agentView.railReturn)
							} else if (workflows.length > 1) {
								setAgentSurface({ ...agentView, focus: 'workflows' })
							}
						}
						return
					}
					// `x` stops what the level lists: the whole workflow on the phases,
					// the one agent on its agents.
					if (input === 'x' && !key.ctrl && !key.meta && agentView.focus !== 'workflows') {
						if (workflow?.runId !== undefined) {
							// A run: the phases level stops the whole run, an agent's level
							// skips that one agent and the script goes on without it.
							if (agentView.focus === 'phases') session?.workflows?.stop(workflow.runId)
							else if (selected?.workflowAgentIndex !== undefined)
								session?.workflows?.skipAgent(workflow.runId, selected.workflowAgentIndex)
							return
						}
						const targets = agentView.focus === 'phases' ? (workflow?.agents ?? []) : [selected]
						for (const member of targets) {
							if (!member) continue
							if (!['completed', 'failed', 'cancelled'].includes(member.status)) {
								session?.stopSubagent?.(member.viewId)
							}
						}
						return
					}
					if (key.rightArrow || key.return) {
						if (agentView.focus === 'workflows') {
							setAgentSurface({
								...agentView,
								focus: workflow ? cockpitEntryFocus(workflow) : 'agents',
							})
							return
						}
						if (agentView.focus === 'phases') {
							setAgentSurface({ ...agentView, focus: 'agents' })
							return
						}
						if (!selected) return
						setAgentSurface({
							kind: 'transcript',
							selectedPhaseId: phase.id,
							selectedId: selected.viewId,
							returnFocus: agentView.focus,
							tailOffset: 0,
							...(agentView.railReturn !== undefined ? { railReturn: agentView.railReturn } : {}),
						})
						return
					}
					if (key.home || key.end || key.pageUp || key.pageDown || key.upArrow || key.downArrow) {
						const movement = key.home
							? 'first'
							: key.end
								? 'last'
								: key.pageUp
									? 'previous-page'
									: key.pageDown
										? 'next-page'
										: key.upArrow
											? 'previous'
											: 'next'
						if (agentView.focus === 'workflows') {
							const next = moveSelection(
								workflowIndex,
								workflows.length,
								movement,
								agentWorkflowPageSize(terminal.rows),
							)
							const targetPhase = workflows[next]?.phases[0]
							const targetAgent = targetPhase?.agents[0]
							if (targetPhase && (targetAgent || workflows[next]?.runId !== undefined)) {
								setAgentSurface({
									...agentView,
									selectedPhaseId: targetPhase.id,
									selectedId: targetAgent?.viewId ?? '',
								})
							}
						} else if (agentView.focus === 'phases') {
							const next = moveSelection(
								phaseIndex,
								phases.length,
								movement,
								agentPhasePageSize(terminal.rows, agentCockpitIsWide(terminal.columns)),
							)
							const targetPhase = phases[next]
							const targetAgent = targetPhase?.agents[0]
							if (targetPhase && (targetAgent || workflow?.runId !== undefined)) {
								setAgentSurface({
									...agentView,
									selectedPhaseId: targetPhase.id,
									selectedId: targetAgent?.viewId ?? '',
								})
							}
						} else {
							const next = moveSelection(
								agentIndex,
								phaseAgents.length,
								movement,
								agentPickerPageSize(terminal.rows, agentCockpitIsWide(terminal.columns)),
							)
							const target = phaseAgents[next]
							if (target) setAgentSurface({ ...agentView, selectedId: target.viewId })
						}
					}
					return
				}

				const selected = agents.find((agent) => agent.viewId === agentView.selectedId)
				if (!selected) {
					setAgentSurface(null)
					return
				}

				if (viewingAgentRef.current === selected.viewId) {
					// Viewing: the main composer is live and owns the typing, so only
					// the keys it does not use are read here.
					//
					// Esc on a running agent stops it and stays in the view; on one that
					// has ended it goes back to the conversation (its row lingers, the
					// draft stays in the composer). Ctrl+C stops a running agent and goes
					// back either way, and interrupts the conversation's own turn too if
					// one is running.
					if (key.escape) {
						if (railActionFor(selected) === 'stop') {
							session?.stopSubagent?.(selected.viewId)
							return
						}
						setAgentSurface(null)
						setViewNotice(undefined)
						return
					}
					if (key.ctrl && input === 'c') {
						if (railActionFor(selected) === 'stop') session?.stopSubagent?.(selected.viewId)
						setAgentSurface(null)
						setViewNotice(undefined)
						if (abortRef.current) interruptWithRow(false)
						return
					}
					if (key.pageUp || key.pageDown || key.home || key.end) {
						const rows = agentViewPageRows(terminal.rows, viewRailRowsRef.current)
						const max = maxAgentViewTailOffset(selected, rows, Math.max(1, terminal.columns - 2))
						const offset = Math.min(agentView.tailOffset, max)
						const next = key.home
							? max
							: key.end
								? 0
								: key.pageUp
									? Math.min(max, offset + rows)
									: Math.max(0, offset - rows)
						setAgentSurface({ ...agentView, tailOffset: next })
						return
					}
					// Everything else belongs to the composer and the rail below.
				} else {
					if (
						(!agentView.composing && input.toLowerCase() === 'q') ||
						(key.ctrl && input === 'c')
					) {
						setAgentSurface(null)
						return
					}
					if (key.escape && agentView.fromRail) {
						setAgentSurface(null)
						setRailFocus(selected.viewId)
						return
					}
					if (key.escape) {
						setAgentSurface({
							kind: 'cockpit',
							selectedPhaseId: agentView.selectedPhaseId,
							selectedId: selected.viewId,
							focus: agentView.returnFocus,
							...(agentView.railReturn !== undefined ? { railReturn: agentView.railReturn } : {}),
						})
						return
					}
					if (key.tab && key.shift) {
						cyclePermissionMode()
						return
					}
					if (key.home || key.end || key.pageUp || key.pageDown || key.upArrow || key.downArrow) {
						// Reserving the replayed banner's row here too keeps one PgDn a
						// screenful of what is actually visible.
						const historyRows = terminal.rows
						const page = agentTranscriptPageSize(historyRows, selected.replayed ? 1 : 0)
						const max = maxAgentTranscriptTailOffset(selected, historyRows, terminal.columns)
						const offset = Math.min(agentView.tailOffset, max)
						const next = key.home
							? max
							: key.end
								? 0
								: key.pageUp
									? Math.min(max, offset + page)
									: key.pageDown
										? Math.max(0, offset - page)
										: key.upArrow
											? Math.min(max, offset + 1)
											: Math.max(0, offset - 1)
						setAgentSurface({ ...agentView, tailOffset: next })
					}
					return
				}
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
				if ((picker.kind === 'plugin' || picker.kind === 'plugin-action') && picker.busy) return
				// Composer publishes a chooser while handling Return. App receives the
				// same input dispatch (and key repeat can arrive before the commit), so
				// the synchronous ref is an ownership fence but not yet an actionable
				// menu. Only the exact object React committed may consume a choice.
				if (choicePickerCommittedRef.current !== picker) return
				const searchable = choicePickerSearchable(picker)
				const options = filterChoiceOptions(picker.options, choiceQueryRef.current)
				const applyVisibleChoice = (index: number) => {
					const option = options[index]
					if (option) applyChoiceSelection(picker.options.indexOf(option))
				}
				if (key.escape || (key.ctrl && input === 'c')) {
					reviewChoiceInFlightRef.current = null
					setSelectedChoice(0)
					setChoicePicker(key.escape ? (picker.back ?? null) : null)
					// Esc leaves the question unanswered and the turn running; the
					// tool tells the model so. Ctrl+C is the operator saying stop.
					if (picker.kind === 'user-question') {
						resolveQuestion({ kind: key.escape ? 'skip' : 'abort' })
					}
					return
				}
				if (key.home || key.end || key.pageUp || key.pageDown) {
					const pageSize = choicePickerWindowSize({
						rows: terminal.rows,
						columns: Math.max(1, (terminal.columns ?? 80) - 2),
						searchable,
						notice: Boolean(picker.notice),
						selectedDescription: options.some((option) =>
							Boolean(option.selectedDescription || option.disabledReason),
						),
						windowSize: picker.kind === 'command' ? picker.windowSize : undefined,
					})
					setSelectedChoice((index) =>
						moveChoiceSelection(
							options,
							index,
							key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
							pageSize,
						),
					)
					return
				}
				if (key.upArrow || (key.leftArrow && picker.kind === 'reasoning-effort')) {
					setSelectedChoice((index) => moveChoiceSelection(options, index, 'previous'))
					return
				}
				if (key.rightArrow && picker.kind === 'reasoning-effort') {
					setSelectedChoice((index) => moveChoiceSelection(options, index, 'next'))
					return
				}
				if (key.tab && picker.kind === 'reasoning-effort') {
					// Tab flips hypermode at whatever effort is highlighted, like the
					// hypermode row does on Enter; the effort itself is left alone.
					applyChoiceSelection(picker.options.length - 1)
					return
				}
				if (key.downArrow) {
					setSelectedChoice((index) => moveChoiceSelection(options, index, 'next'))
					return
				}
				if (key.return) {
					applyVisibleChoice(selectedChoiceRef.current)
					return
				}
				if (searchable && !key.ctrl && !key.meta && (key.backspace || key.delete || input)) {
					const next =
						key.backspace || key.delete
							? eraseLastChoiceGrapheme(choiceQueryRef.current)
							: choiceQueryRef.current + input.replace(/\p{Cc}/gu, '')
					choiceQueryRef.current = next
					setChoiceQuery(next)
					setSelectedChoice(
						moveChoiceSelection(filterChoiceOptions(picker.options, next), 0, 'first'),
					)
					return
				}
				if (picker.kind === 'workflow-runs' && input === 'x' && !key.ctrl && !key.meta) {
					// Stops the highlighted run when it is still going; a finished one has nothing to stop.
					const chosen = options[selectedChoiceRef.current]
					const runId = chosen ? picker.values[picker.options.indexOf(chosen)] : undefined
					const run = workflowRunsRef.current.find((item) => item.runId === runId)
					if (run?.status === 'running') {
						session?.workflows?.stop(run.runId)
						setChoicePicker(null)
						pushMessage('system', `Stopping ${run.name}.`)
					}
					return
				}
				if (/^[1-9]$/.test(input)) {
					const index = Number(input) - 1
					if (options[index]) applyVisibleChoice(index)
				}
				return
			}
			// `/copy` holds a source snapshot, not a lifecycle phase. Permission
			// stays above it in this handler so an approval request that arrives
			// while the picker is open cannot have its keys stolen by the chooser.
			if (copyPickerRef.current) {
				// The Return that submitted `/copy` is an ownership fence, not a
				// selection made against a picker the operator has not seen yet.
				if (copyPickerCommittedRef.current !== copyPickerRef.current) return
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
							key.home ? 'first' : key.end ? 'last' : key.pageUp ? 'previous-page' : 'next-page',
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
					pushMessage('system', 'Ctrl+L is unavailable while a reply is in progress.')
					return
				}
				setMessages([])
				resetTranscript()
				return
			}
			// A turn a tool paused for a person: Enter on an empty composer
			// continues it, Esc stops it (the turn is abandoned, like /abandon).
			if (
				handoffParkRef.current &&
				phase === 'ready' &&
				state === 'idle' &&
				!abortRef.current &&
				((key.return && !composerHasDraft) || key.escape)
			) {
				const parked = handoffParkRef.current
				setHandoffPark(null)
				if (key.return) void resumeActiveTurn({ handoffReason: parked.reason })
				else void abandonActiveTurn('The operator stopped the turn a tool paused for them.')
				return
			}
			// A queued message chosen for editing: Esc only leaves the choice.
			if (key.escape && queueSelectionRef.current !== null) {
				setQueueSelection(null)
				return
			}
			// Esc interrupts the running turn. Its pending steer can start a fresh
			// turn, while a next-turn queue remains visible for the operator.
			if (key.escape && (abortRef.current || pendingModelSwitchRef.current)) {
				interruptWithRow(true, { always: true })
				return
			}
			// Ctrl+O opens the detailed transcript: every row whole, thinking
			// included. It replaces the composer until a key closes it.
			if (key.ctrl && input === 'o') {
				setTranscriptScreen(true)
				return
			}
			// Ctrl+D on an empty composer arms the same exit Ctrl+C does; with
			// anything typed it stays the composer's delete-forward key.
			if (
				key.ctrl &&
				input === 'd' &&
				phase === 'ready' &&
				!composerHasDraft &&
				permission === null &&
				textPrompt === null &&
				choicePickerRef.current === null &&
				copyPicker === null
			) {
				armExit('Ctrl-D')
				return
			}
			if (key.ctrl && input === 'c') {
				// A turn is running → first Ctrl+C interrupts it, not exits.
				// Drops the ref, so a second Ctrl+C arms exit instead of re-aborting
				// (which spammed "Interrupted." lines).
				if (interruptWithRow(false)) return
				// Nothing is running in the conversation: Ctrl+C ends the background
				// agents first, once, and says so. Exit arms only when none is left.
				const stoppable = stoppableBackgroundAgents(railRowsRef.current)
				if (stoppable.length > 0) {
					stopBackgroundAgentsByOperator(stoppable, stopAllStep(stoppable.length, true).notice)
					return
				}
				armExit('Ctrl-C')
			}
		},
		// Active on every phase. It was gated off during the picker, which is what
		// left that screen without a usable exit; the picker branch above returns
		// immediately, so the Picker still owns everything except Ctrl+C.
		{ isActive: externalEditorRequest === null && !providerSetup },
	)

	// Background is left natural — we inherit the terminal's own background
	// and only theme the foreground. Forcing
	// a filled bg left mismatched patches around bordered areas, so we don't.
	const liveSubagents = railAgents(subagents, railNow, dismissedAgents, pinnedViewId)
	railRowsRef.current = liveSubagents
	const liveWorkflows = railWorkflows(subagents, railNow, dismissedAgents, workflowRuns, {
		hypermode,
		...(ctxRef.current.workflow?.sizeGuideline !== undefined
			? { configuredGuideline: ctxRef.current.workflow.sizeGuideline }
			: {}),
		env: process.env,
	})
	const backgroundGroups = liveGroups(subagents, isWorkflowRunAgent)
	const closingWait = closingWaitRef.current
	const backgroundWaitText =
		closingWait !== null && state === 'idle'
			? backgroundWaitLine(
					pendingBackgroundAgents(
						subagents.filter((agent) => agent.startedAt >= closingWait.since),
						isWorkflowRunAgent,
					).length,
					workflowRuns.filter((run) => run.status === 'running').length,
				)
			: undefined
	railWorkflowsRef.current = liveWorkflows
	const representedSubagentTools = new Set(
		subagents
			.filter((agent) => agent.toolUseId !== undefined)
			.map((agent) => JSON.stringify([agent.workflowId, agent.toolUseId])),
	)
	const representedUnscopedSubagentToolUseIds = new Set(
		subagents.map((agent) => agent.toolUseId).filter((id): id is string => id !== undefined),
	)
	// Keep the exact parent Agent row suppressed through the child-settled →
	// tool-end hand-off. The monitor publishes terminal state synchronously,
	// while the provider event that removes the generic tool row arrives on the
	// next tick; filtering only live children made that raw row flash back.
	const visibleActiveTools = activeTools.filter(
		(tool) =>
			tool.fold === undefined &&
			(tool.toolName.toLowerCase() !== 'agent' ||
				!(tool.turnId
					? representedSubagentTools.has(JSON.stringify([tool.turnId, tool.id]))
					: representedUnscopedSubagentToolUseIds.has(tool.id))),
	)
	const selectedSubagent = agentSurface
		? subagents.find((agent) => agent.viewId === agentSurface.selectedId)
		: undefined
	const childComposerAvailable = Boolean(
		session?.messageSubagent &&
			selectedSubagent &&
			!selectedSubagent.replayed &&
			selectedSubagent.workflowRunId === undefined &&
			agentSurface?.kind === 'transcript',
	)
	// An agent that can take messages is VIEWED, not browsed: its transcript
	// shows on the main screen and the one composer stays live and talks to it.
	// Saved children and a workflow run's agents cannot be messaged and keep the
	// read-only screen.
	const viewingAgent = childComposerAvailable ? selectedSubagent : undefined
	viewingAgentRef.current = viewingAgent?.viewId ?? null
	const lifecycleOwnsViewport =
		transcriptScreen ||
		scrollOpen ||
		jobSurface !== null ||
		scheduleReviewPrompt !== null ||
		phase === 'trust' ||
		phase === 'resume' ||
		phase === 'unarchive' ||
		phase === 'edit' ||
		phase === 'picker' ||
		agentSurface !== null
	const statusGoal =
		phase === 'ready' &&
		state === 'idle' &&
		conversationMutation === null &&
		!compacting &&
		permission === null &&
		textPrompt === null &&
		choicePicker === null &&
		copyPicker === null &&
		scheduleReviewPrompt === null &&
		agentSurface === null &&
		jobSurface === null
			? goalStatusLabel(
					goalStatus,
					goalStatus ? goalActivation.isArmed(goalStatus.sessionId, goalStatus) : false,
				)
			: null
	// The effort chooser is a left-to-right slider wherever its stops fit on
	// one row, and the vertical list everywhere else (see EffortSlider.tsx).
	const effortSlider =
		choicePicker?.kind === 'reasoning-effort'
			? effortSliderLayout(
					choicePicker.options.map((option) => option.label),
					Math.max(1, (terminal.columns ?? 80) - 2),
				)
			: undefined
	// A screen with its own box (a picker, a prompt, the agents or shells view)
	// prints its key hints inside that box. The footer stays quiet then, so a
	// screen never says the same keys twice (see key-hints.ts).
	const boxOwnsKeys =
		permission !== null ||
		scheduleReviewPrompt !== null ||
		saveSkillPrompt !== null ||
		planPrompt !== null ||
		questionDialog !== null ||
		agentSurface !== null ||
		jobSurface !== null ||
		textPrompt !== null ||
		choicePicker !== null ||
		copyPicker !== null ||
		phase === 'trust' ||
		phase === 'resume' ||
		phase === 'unarchive' ||
		phase === 'edit' ||
		phase === 'picker'
	// A question or a picker owns the screen: the footer is not drawn under it,
	// so a dialog never shows a half footer (the model alone, or a mode label
	// without its cycle hint). Only a transient notice, such as the press-again
	// to exit line, still needs the footer row.
	const dialogShowing =
		permission !== null ||
		scheduleReviewPrompt !== null ||
		saveSkillPrompt !== null ||
		planPrompt !== null ||
		questionDialog !== null ||
		textPrompt !== null ||
		choicePicker !== null ||
		copyPicker !== null ||
		phase === 'resume' ||
		phase === 'unarchive' ||
		phase === 'edit' ||
		phase === 'picker'
	// What the footer's right end says, in order: the exit reminder, an
	// immediate notice (it covers the pause and phase hints for its few
	// seconds), the pause and phase hints, then a lower-priority notice (the
	// context meter) in the StatusBar's own order behind them.
	const currentNotice = notices.current
	const noticeIsImmediate = currentNotice?.priority === 'immediate'
	const statusHint = exitHint
		? `Press ${exitHint} again to exit`
		: noticeIsImmediate
			? undefined
			: conversationMutation === 'fork'
				? 'forking conversation — input is paused'
				: conversationMutation === 'edit'
					? 'branching before prompt — input is paused'
					: conversationMutation === 'archive'
						? 'archiving conversation — input is paused'
						: conversationMutation === 'new'
							? 'starting a fresh conversation — input is paused'
							: compacting
								? 'compacting conversation — input is paused'
								: boxOwnsKeys
									? undefined
									: handoffPark && phase === 'ready' && state === 'idle' && !composerHasDraft
										? 'enter continue · esc stop'
										: goalStatus && phase === 'ready' && state === 'idle'
											? undefined
											: hintForPhase(phase, state, composerHasDraft)
	const permissionSource = reviewSource(permission, scopeRef.current?.sessionId)
	const permissionOwner = permissionSource
		? subagents.find((agent) => agent.sessionId === permissionSource)
		: undefined
	const permissionSourceLabel = permissionSource
		? permissionOwner
			? `from the ${permissionOwner.description} agent`
			: 'from another agent'
		: undefined
	const displayedPermissionMode = permissionMode
	const highestEffort = highestReasoningEffort(session?.reasoningEffortLevels)
	const composerTriggers: ComposerTriggerSettings | undefined = composerTriggersOn
		? {
				registry: composerTriggerRegistry,
				suggest: composerTriggerSettings.suggest,
				context: {
					permissionMode: displayedPermissionMode,
					sessionHypermode: hypermode,
					effortMenu: highestEffort !== undefined,
					agentTool: true,
					skillCreator: skillCreatorAvailable,
					scheduleTool: true,
				},
				...(highestEffort ? { highestEffort } : {}),
			}
		: undefined
	// True exactly when the phase ternary below renders its final branch — the
	// normal composer view, as opposed to provider setup or a lifecycle
	// picker/prompt. The agent rail is a feature of that view: computing this
	// once here lets its render site sit after the footer, below, while still
	// never appearing during trust/resume/edit/picker/setup phases.
	const showComposerSurface =
		!providerSetup &&
		phase !== 'trust' &&
		phase !== 'unhealthy' &&
		phase !== 'resume' &&
		phase !== 'edit' &&
		phase !== 'picker'
	const childSurfaceOpen =
		(agentSurface !== null && viewingAgent === undefined) || transcriptScreen || jobSurface !== null
	const viewRailRows =
		liveSubagents.length > 0 || liveWorkflows.length > 0
			? 1 +
				(railShowsMain(liveSubagents.length, viewingAgent?.viewId) ? 1 : 0) +
				Math.min(liveSubagents.length, AGENT_RAIL_WINDOW) +
				(liveSubagents.length > AGENT_RAIL_WINDOW ? 1 : 0) +
				liveWorkflows.length
			: 0
	viewRailRowsRef.current = viewRailRows
	const viewPageRows = agentViewPageRows(terminal.rows, viewRailRows)
	// `←` and `↓` act only from an empty composer with the keyboard in it, so
	// the footer names them under the same conditions and never advertises a dead key.
	const footerKeysLive =
		showComposerSurface &&
		!childSurfaceOpen &&
		!composerHasDraft &&
		permission === null &&
		railFocus === null
	const runningAgentCount = liveSubagents.filter((agent) => railActionFor(agent) === 'stop').length
	// `/workflows`: `x to stop` is offered only on a run that is still going.
	const workflowPickerCanStop = (() => {
		if (choicePicker?.kind !== 'workflow-runs') return false
		const chosen = filterChoiceOptions(choicePicker.options, choiceQuery)[selectedChoice]
		const runId = chosen ? choicePicker.values[choicePicker.options.indexOf(chosen)] : undefined
		return workflowRunsRef.current.find((run) => run.runId === runId)?.status === 'running'
	})()
	// A run is one workflow, not an agent: the footer says so.
	const runningWorkflowCount = liveWorkflows.filter((flow) => flow.status === 'running').length
	// While the rail has the keyboard its key line replaces the footer's mode line.
	const railHintText =
		railFocus !== null &&
		railFocus !== SHELLS_FOCUS &&
		showComposerSurface &&
		permission === null &&
		(agentSurface === null || viewingAgent !== undefined) &&
		(liveSubagents.length > 0 || liveWorkflows.length > 0)
			? railHint(
					railFocus === 'main'
						? undefined
						: (liveSubagents.find((agent) => agent.viewId === railFocus) ??
								liveWorkflows.find((flow) => flow.focusId === railFocus)),
					terminal.columns,
					liveSubagents.filter((agent) => railActionFor(agent) === 'stop').length,
					viewingAgent?.viewId,
				)
			: undefined
	return (
		// One row short of the terminal, always: see ViewportBound.tsx for the
		// renderer path a taller frame takes and the scrollback row it costs.
		<ViewportBound rows={terminal.rows} display={externalEditorRequest ? 'none' : 'flex'}>
			<Box flexDirection="column" paddingX={1}>
				{/* Keep the Static owner mounted through startup pickers. Removing its
				    ancestor frees Yoga memory that Ink still references during its final flush. */}
				<TranscriptFrame>
					<Transcript
						messages={finalized}
						pending={messages.find((m) => m.pending) ?? null}
						pendingAt={pendingAt}
						state={state}
						settled={transcriptOwned ? renderedSettled : 0}
						resetKey={resetKey}
						raw={rawOutput}
						hyperlinks={hyperlinks}
						showLive={!lifecycleOwnsViewport}
						// The one column of padding the enclosing box gives every row.
						staticIndent={1}
						header={
							transcriptOwned ? (
								<BrandHeader
									version={ctx.version}
									permissionMode={displayedPermissionMode}
									cwd={ctx.cwd}
								/>
							) : undefined
						}
					/>
				</TranscriptFrame>
				{providerSetup ? (
					<ProviderSetup
						cwd={ctx.cwd}
						onClose={() => setProviderSetup(false)}
						onConnect={() => {
							setProviderSetup(false)
							setPickerInitialView('providers')
							setPickerDetected(null)
							setPickerSelectionKind('provider-and-model')
							setPhase('picker')
							void discoverProviders({ skipProbes: true })
								.then(setPickerDetected)
								.catch((error) =>
									setPickerNotice(explainFailure(error, 'Could not look for providers.')),
								)
						}}
					/>
				) : phase === 'trust' ? (
					<TrustPrompt cwd={ctx.cwd} grants={trustGrants} />
				) : phase === 'unhealthy' ? (
					// The sentence above already says what to do when it is a complete
					// one; saying "resolve the error above" under it is the same advice
					// twice.
					startupExplained ? null : (
						<Box flexDirection="column" marginTop={1}>
							<Text color={theme.status.error} bold>
								Startup stopped
							</Text>
							<Text color={theme.text.secondary}>Resolve the error above, then restart Namzu.</Text>
						</Box>
					)
				) : phase === 'resume' || phase === 'unarchive' ? (
					<ResumePicker
						conversations={resumeList}
						selected={selectedResume}
						mode={phase === 'unarchive' ? 'restore' : 'resume'}
					/>
				) : phase === 'edit' ? (
					rewind ? (
						<RewindPicker
							rows={rewind.rows}
							state={rewind.state}
							options={optionsFor(rewind.state, {
								rows: rewind.rows,
								canSummarize: Boolean(session?.compactRange),
							})}
							checkpointing={Boolean(session?.checkpoints)}
							now={rewind.openedAt}
							working={rewind.state.busy?.startsWith('summarize') ? 'Summarizing…' : 'Restoring…'}
						/>
					) : null
				) : phase === 'picker' ? (
					<Picker
						detected={pickerDetected ?? detected}
						currentProvider={currentProvider}
						selectionKind={pickerSelectionKind}
						currentModel={session?.modelSummary ?? null}
						{...(ctx.routing && session?.hasProvider && !palDefinitionRef.current
							? { auto: { active: autoActive }, onAuto: handlePickerAuto }
							: {})}
						initialView={pickerInitialView}
						onSubmit={handlePickerSubmit}
						onCancel={handlePickerCancel}
						onSetup={() => setProviderSetup(true)}
						onCredential={handleTypedCredential}
						onLogin={startLoginFromPicker}
						onLoginComplete={finishLoginFromPicker}
						keyEntryFor={keyEntryFor}
						notice={pickerNotice}
						// The same condition `handlePickerCancel` branches on, read
						// where it is decided rather than guessed on the screen: with no
						// session behind the picker, esc exits namzu and the footer says
						// so instead of offering a cancel nobody will see.
						cancelExits={!session?.hasProvider}
					/>
				) : (
					<>
						{/* Keep the inline viewport minimal: finalized history flows into native
						    scrollback, while activity and input follow the visible tail directly.
						    A viewport-height blank box here creates dead space and makes resize
						    depend on an estimate of rows Ink has already rendered. */}
						{/* Messages typed while a reply runs sit directly above the working row,
						    as in other terminal agents: pending rows, the send-now hint, then `Working`. */}
						{pendingInputVisible ? (
							<PendingInputPanel
								pendingSteers={pendingInputItems}
								queued={queuedInputItems}
								columns={Math.max(2, (terminal.columns ?? 80) - 2)}
								rows={terminal.rows}
								working={abortRef.current !== null}
								selectedQueued={queueSelection}
								held={queuePause}
							/>
						) : null}
						{agentSurface === null &&
						!transcriptScreen &&
						!scrollOpen &&
						jobSurface === null &&
						scheduleReviewPrompt === null ? (
							<LiveActivity
								compact={compactWork}
								{...(compacting || summarising ? { activityLabel: COMPACTING_LABEL } : {})}
								activeTools={visibleActiveTools}
								working={state === 'thinking' || state === 'tool'}
								compacting={compacting}
								animate={
									stdout.isTTY === true &&
									permission === null &&
									textPrompt === null &&
									saveSkillPrompt === null &&
									planPrompt === null &&
									questionDialog === null &&
									scheduleReviewPrompt === null
								}
								thinking={thinking}
								{...(spinnerTip ? { tip: spinnerTip } : {})}
								{...(nextPlanned ? { nextTask: nextTaskLine(nextPlanned) } : {})}
								waitNotice={providerWaitNotice}
								tokens={turnTokens}
								waitingForYou={
									choicePicker !== null ||
									permission !== null ||
									textPrompt !== null ||
									saveSkillPrompt !== null ||
									planPrompt !== null ||
									questionDialog !== null ||
									scheduleReviewPrompt !== null
								}
							/>
						) : null}
						{agentSurface === null &&
						!transcriptScreen &&
						!scrollOpen &&
						jobSurface === null &&
						permission === null &&
						scheduleReviewPrompt === null ? (
							<BackgroundAgentRows
								groups={backgroundGroups}
								waitLine={backgroundWaitText}
								glyph={CLOSING_GLYPH}
							/>
						) : null}
						{/* The step the plan is on, while its checklist is out of view.
						    A sibling of the activity rows, not a mode: the composer
						    below stays mounted and usable while it is up. */}
						{agentSurface === null &&
						!transcriptScreen &&
						!scrollOpen &&
						jobSurface === null &&
						permission === null &&
						scheduleReviewPrompt === null ? (
							<TaskList tasks={liveTasks} />
						) : null}
						{/* Siblings, not a ternary. The overlay used to REPLACE the
						    composer, which unmounted it and destroyed whatever the
						    operator was part-way through typing — text, paste chips
						    and pasted images alike — on an event they did not
						    trigger. The composer now stays mounted and draws
						    nothing while the prompt is up, so its state survives a
						    decision it had nothing to do with. */}
						{permission && !transcriptScreen ? (
							<PermissionOverlay
								toolCalls={permission.toolCalls}
								review={permission.review}
								summary={permission.summary}
								detailsOpen={permissionDetailsOpen}
								reviewOffset={permissionReviewOffset}
								choice={permissionChoice}
								{...(permissionCount ? { count: permissionCount } : {})}
								{...(permissionSourceLabel ? { from: permissionSourceLabel } : {})}
								{...(permissionReason !== null ? { reason: permissionReason } : {})}
								endsTurn={endsTurnOnNo(permission)}
								columns={terminal.columns}
								rows={terminal.rows}
								batchOnly={permission.batchOnly === true}
								mode={permissionMode}
								{...(session?.allowForSession && session.commandArguments
									? {
											commandArguments: session.commandArguments,
											rememberWhere: displayPath(ctx.cwd, 28),
										}
									: {})}
								siteNotes={permission.siteNotes}
								withheld={permission.withheld}
								{...(permission.screenConsent === true
									? {
											screenConsent: {
												provider: session?.providerSummary ?? null,
											},
										}
									: {})}
							/>
						) : null}
						{saveSkillPrompt &&
						permission === null &&
						scheduleReviewPrompt === null &&
						!transcriptScreen ? (
							<SaveSkillOverlay
								key={saveSkillPrompt.request.markdown}
								request={saveSkillPrompt.request}
								cwd={ctx.cwd}
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
								rows={terminal.rows}
								onAnswer={saveSkillPrompt.resolve}
							/>
						) : null}
						{planPrompt &&
						permission === null &&
						scheduleReviewPrompt === null &&
						!transcriptScreen ? (
							<PlanApprovalOverlay
								key={planPrompt.request.plan}
								request={planPrompt.request}
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
								rows={terminal.rows}
								onAnswer={planPrompt.resolve}
								onInterrupt={interruptTurn}
							/>
						) : null}
						{questionDialog &&
						permission === null &&
						scheduleReviewPrompt === null &&
						!transcriptScreen ? (
							<QuestionDialog
								key={questionDialog.token}
								question={questionDialog.question}
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
								onAnswer={finishQuestionDialog}
							/>
						) : null}
						{scheduleReviewPrompt && permission === null && !transcriptScreen ? (
							<ScheduleReviewOverlay
								key={scheduleReviewPrompt.token}
								request={scheduleReviewPrompt.request}
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
								rows={Math.max(1, (terminal.rows ?? 24) - 2)}
								onAnswer={scheduleReviewPrompt.resolve}
							/>
						) : null}
						{textPrompt ? (
							<TextPrompt
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
								key={textPrompt.token}
								title={textPrompt.title}
								placeholder={textPrompt.placeholder}
								initialValue={textPrompt.initialValue}
								emptyNotice={textPrompt.emptyNotice}
								hidden={permission !== null || scheduleReviewPrompt !== null || childSurfaceOpen}
								onSubmit={submitTextPrompt}
								onCancel={cancelTextPrompt}
							/>
						) : permission === null &&
							scheduleReviewPrompt === null &&
							!childSurfaceOpen &&
							choicePicker?.kind === 'reasoning-effort' &&
							effortSlider ? (
							<EffortSlider
								title={choicePicker.title}
								notice={choicePicker.notice}
								options={choicePicker.options}
								selected={selectedChoice}
								layout={effortSlider}
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
							/>
						) : permission === null &&
							scheduleReviewPrompt === null &&
							!childSurfaceOpen &&
							choicePicker ? (
							<ChoicePicker
								busy={'busy' in choicePicker && choicePicker.busy === true}
								columns={Math.max(1, (terminal.columns ?? 80) - 2)}
								title={choicePicker.title}
								notice={choicePicker.notice}
								{...(choicePicker.kind === 'workflow-runs'
									? {
											subtitle: choicePicker.subtitle,
											hints: workflowRunsHints(workflowPickerCanStop),
										}
									: {})}
								options={filterChoiceOptions(choicePicker.options, choiceQuery)}
								query={choicePickerSearchable(choicePicker) ? choiceQuery : undefined}
								selected={selectedChoice}
								windowSize={
									choicePicker.kind === 'command' || choicePicker.kind === 'theme'
										? choicePicker.windowSize
										: undefined
								}
								{...(choicePicker.kind === 'theme' && terminal.rows >= 26
									? { extra: <ThemeSample width={Math.max(10, (terminal.columns ?? 80) - 6)} /> }
									: {})}
							/>
						) : permission === null &&
							scheduleReviewPrompt === null &&
							!childSurfaceOpen &&
							copyPicker ? (
							<CopyPicker targets={copyPicker.targets} selected={selectedCopy} />
						) : null}
						{scrollOpen && permission === null && scheduleReviewPrompt === null ? (
							<TranscriptScrollView
								messages={finalized}
								pending={messages.find((m) => m.pending) ?? null}
								pendingAt={pendingAt}
								height={Math.max(3, terminal.rows - SCROLL_VIEW_RESERVED_ROWS)}
								columns={Math.max(4, terminal.columns - 2)}
								onClose={() => setScrollOpen(false)}
							/>
						) : null}
						{viewingAgent &&
						agentSurface?.kind === 'transcript' &&
						permission === null &&
						choicePicker === null ? (
							<AgentView
								agent={viewingAgent}
								tailOffset={agentSurface.tailOffset}
								pageRows={viewPageRows}
								terminalColumns={Math.max(1, terminal.columns - 2)}
								notice={viewNotice}
							/>
						) : null}
						<ComposerFrame
							columns={Math.max(2, (terminal.columns ?? 80) - 2)}
							working={state === 'thinking' || state === 'tool' || visibleActiveTools.length > 0}
							{...(hypermode ? { mode: HYPERMODE } : {})}
							activation={hypermodeActivation}
							animate={externalEditorRequest === null}
							focus={
								phase === 'ready' &&
								state !== 'awaiting-permission' &&
								!compacting &&
								externalEditorRequest === null &&
								conversationMutation === null &&
								textPrompt === null &&
								choicePicker === null &&
								copyPicker === null &&
								saveSkillPrompt === null &&
								planPrompt === null &&
								questionDialog === null &&
								scheduleReviewPrompt === null &&
								!scrollOpen &&
								!childSurfaceOpen
							}
							hidden={
								permission !== null ||
								saveSkillPrompt !== null ||
								planPrompt !== null ||
								questionDialog !== null ||
								scheduleReviewPrompt !== null ||
								textPrompt !== null ||
								choicePicker !== null ||
								copyPicker !== null ||
								childSurfaceOpen
							}
						>
							<Composer
								{...(viewingAgent
									? {
											placeholder: `Message @${[...viewingAgent.agentId].slice(0, 20).join('')}…`,
										}
									: examplePrompts &&
											history.length === 0 &&
											!messages.some((message) => message.role === 'user')
										? {
												placeholder: examplePlaceholder(exampleFile, exampleSeedRef.current),
											}
										: {})}
								reasoningEffortLevels={session?.reasoningEffortLevels}
								onCycleMode={cyclePermissionMode}
								disabled={
									transcriptScreen ||
									scrollOpen ||
									jobSurface !== null ||
									phase !== 'ready' ||
									state === 'awaiting-permission' ||
									compacting ||
									conversationMutation !== null ||
									externalEditorRequest !== null ||
									railFocus !== null ||
									childSurfaceOpen
								}
								hidden={
									permission !== null ||
									saveSkillPrompt !== null ||
									planPrompt !== null ||
									questionDialog !== null ||
									scheduleReviewPrompt !== null ||
									textPrompt !== null ||
									choicePicker !== null ||
									copyPicker !== null ||
									childSurfaceOpen
								}
								// A turn is running, so Esc is the interrupt and not
								// the composer's clear.
								escapeInterrupts={
									(!compacting &&
										(state === 'thinking' ||
											state === 'tool' ||
											pendingModelSwitchRef.current !== null)) ||
									(handoffPark !== null && state === 'idle')
								}
								onSubmit={handleSubmit}
								onNotice={(text) => pushMessage('system', text)}
								onFooterNotice={notices.add}
								onFooterNoticeRemove={notices.remove}
								onClearedDraft={(text) => setHistory((prev) => [...prev, text])}
								onStepReasoningEffort={stepReasoningEffort}
								onExternalEdit={requestExternalEditor}
								onEditPrevious={openPromptEditor}
								draftToRestore={composerDraft}
								onDraftRestored={(token) =>
									setComposerDraft((draft) => (draft?.token === token ? null : draft))
								}
								onDraftPresenceChange={setComposerHasDraft}
								onOpenAgentPanel={focusAgentRail}
								onOpenAgents={() => void openAgentCockpit()}
								onScrollTranscript={() => setScrollOpen(true)}
								onRecallQueued={recallQueuedPrompt}
								queuedHintCount={queuedHintCount}
								queuedEdit={{
									available: queued.some(isRecallableHumanPrompt),
									selected: queueSelection !== null,
									onMove: moveQueueSelection,
									onLoad: loadSelectedQueued,
									onLeave: () => setQueueSelection(null),
								}}
								onSendNow={sendPendingNow}
								onStopAllAgents={requestStopAllAgents}
								railFocused={railFocus !== null}
								userCommands={userCommands}
								builtins={hostCommands.map((command) => ({
									...command,
									description: command.unavailable?.(slashCtx) ?? command.description,
								}))}
								mentionCandidates={mentionCandidates}
								history={history}
								{...(composerTriggers ? { triggers: composerTriggers } : {})}
								turnActive={!compacting && (state === 'thinking' || state === 'tool')}
							/>
						</ComposerFrame>
					</>
				)}
				{/* Directly below the message frame's bottom border (or, when that
				    frame is hidden by a full-screen surface below, directly below
				    where it would be) — see docs/cli/terminal-design.md#the-composer-footer.
				    Every panel that can follow (the agent rail, the cockpit, a child
				    transcript, the detailed transcript) renders after this line, not
				    before it. */}
				{/* The trust screen already names the folder and its own keys; a footer
				    under it would print the same path and advertise a cycle key that
				    does nothing before the folder is trusted. */}
				{phase === 'trust' ||
				transcriptScreen ||
				!showComposerSurface ||
				statusLineText === undefined ? null : (
					<StatusLineRows text={statusLineText} padding={ctx.statusLine?.padding ?? 0} />
				)}
				{/* The detailed transcript carries its own key line; the mode footer above
				    its box was a stale row from the composer it replaced. */}
				{/* The workflow detail (the cockpit) carries its own key line as well. */}
				{phase === 'trust' ||
				transcriptScreen ||
				agentSurface?.kind === 'cockpit' ||
				(dialogShowing && !exitHint && !noticeIsImmediate) ? null : (
					<StatusBar
						provider={session?.providerSummary ?? null}
						model={
							autoActive && ctx.routing && !palDefinitionRef.current
								? autoModelLabel(session?.autoRoute)
								: (session?.modelSummary ?? null)
						}
						effort={reasoningEffort}
						hypermode={hypermode}
						goal={statusGoal}
						state={state}
						hint={statusHint}
						hintDim={exitHint !== null}
						notice={
							currentNotice && (noticeIsImmediate || !boxOwnsKeys)
								? {
										text: currentNotice.text,
										...(currentNotice.tone ? { tone: currentNotice.tone } : {}),
									}
								: null
						}
						ambient={updateNotice}
						dialogOpen={boxOwnsKeys}
						permissionMode={displayedPermissionMode}
						canCycleMode
						composerMounted={showComposerSurface}
						restingHint={ctx.statusLine === undefined}
						shellCount={showComposerSurface && !childSurfaceOpen ? runningShellCount : 0}
						monitorCount={showComposerSurface && !childSurfaceOpen ? runningMonitorCount : 0}
						pr={prStatus}
						hyperlinks={hyperlinks}
						agentCount={footerKeysLive ? runningAgentCount : 0}
						workflowCount={footerKeysLive ? runningWorkflowCount : 0}
						canManage={
							footerKeysLive && railFocus === null && (runningShellCount > 0 || railHasRows)
						}
						shellsSelected={railFocus === SHELLS_FOCUS}
						{...(railHintText !== undefined ? { railHint: railHintText } : {})}
					/>
				)}
				{/* The parent's commentary, between the footer line and the rail:
				    below the footer like every other panel, and above the rail's
				    border so it reads as the turn talking rather than as chrome the
				    panel drew. Not conditioned on the rail having rows — between two
				    phases there are none, and that is exactly when a line saying what
				    comes next is worth the row. It draws nothing when there is no
				    commentary. */}
				{showComposerSurface &&
				permission === null &&
				agentSurface === null &&
				!transcriptScreen &&
				!scrollOpen &&
				jobSurface === null &&
				scheduleReviewPrompt === null ? (
					<AgentNarrationBand lines={narration} />
				) : null}
				{showComposerSurface &&
				(agentSurface === null || viewingAgent !== undefined) &&
				!transcriptScreen &&
				!scrollOpen &&
				jobSurface === null &&
				scheduleReviewPrompt === null &&
				(liveSubagents.length > 0 || liveWorkflows.length > 0 || viewingAgent !== undefined) ? (
					// The active agents remain in memory while the schedule review
					// owns the available rows; the panel returns after the decision.
					<AgentTaskPanel
						agents={liveSubagents}
						workflows={liveWorkflows}
						terminalRows={terminal.rows}
						terminalColumns={terminal.columns}
						compact={permission !== null}
						viewingId={viewingAgent?.viewId ?? null}
						{...(railFocus !== null && railFocus !== SHELLS_FOCUS
							? {
									selectedIndex:
										railFocus === 'main'
											? 0
											: railFocus.startsWith('workflow:')
												? liveSubagents.length +
													(railShowsMain(liveSubagents.length, viewingAgent?.viewId) ? 1 : 0) +
													Math.max(
														0,
														liveWorkflows.findIndex((flow) => flow.focusId === railFocus),
													)
												: liveSubagents.findIndex((agent) => agent.viewId === railFocus) +
													(railShowsMain(liveSubagents.length, viewingAgent?.viewId) ? 1 : 0),
								}
							: {})}
					/>
				) : showComposerSurface &&
					permission === null &&
					scheduleReviewPrompt === null &&
					agentSurface?.kind === 'cockpit' ? (
					<AgentCockpit
						agents={subagents}
						runs={workflowRuns}
						selectedPhaseId={agentSurface.selectedPhaseId}
						selectedId={agentSurface.selectedId}
						focus={agentSurface.focus}
						terminalRows={terminal.rows}
						terminalColumns={terminal.columns}
					/>
				) : showComposerSurface &&
					permission === null &&
					scheduleReviewPrompt === null &&
					agentSurface?.kind === 'transcript' &&
					selectedSubagent &&
					viewingAgent === undefined ? (
					<AgentTranscript
						agent={selectedSubagent}
						tailOffset={agentSurface.tailOffset}
						terminalRows={terminal.rows}
						terminalColumns={terminal.columns}
						escapeTo={agentSurface.fromRail ? 'back' : 'agents'}
					/>
				) : null}
				{transcriptScreen ? (
					<TranscriptScreen
						messages={finalized}
						pending={messages.find((m) => m.pending) ?? null}
						pendingAt={pendingAt}
						rows={terminal.rows}
						columns={terminal.columns}
						hyperlinks={hyperlinks}
						dialogWaiting={
							permission !== null ||
							saveSkillPrompt !== null ||
							planPrompt !== null ||
							questionDialog !== null ||
							scheduleReviewPrompt !== null
						}
						onClose={() => setTranscriptScreen(false)}
					/>
				) : null}
				{jobSurface && permission === null && scheduleReviewPrompt === null ? (
					<BackgroundJobsPanel
						jobs={backgroundJobs}
						selectedJobId={jobSurface.selectedJobId}
						detailJobId={jobSurface.detailJobId}
						tailOffset={jobSurface.tailOffset}
						readJob={(id) => session?.readJob?.(id)}
						rows={terminal.rows}
						columns={Math.max(1, terminal.columns - 2)}
						now={jobClock}
						busyJobId={jobSurface.busyJobId}
						notice={jobSurface.notice}
					/>
				) : null}
			</Box>
		</ViewportBound>
	)
}

/**
 * The notice for a project whose settings could not be applied. A config file
 * that is not valid JSON has Namzu's own sentence already (file, line, column,
 * what to do); the parser's wording follows it only under `--debug`.
 */
/**
 * The gutter glyph of the sentence that stops startup: blank, so the sentence
 * starts at the same column as the rest without a dot in front of it. The
 * system dot marks a note between turns, and this is not one.
 */
const STARTUP_STOP_GLYPH = ' '

function projectSettingsFailure(err: unknown): string {
	if (err instanceof ConfigLoadError && err.complete) {
		const raw = err.cause instanceof Error ? err.cause.message : undefined
		return raw && debugRequested() ? `${err.message}\n${raw}` : err.message
	}
	return err instanceof Error && err.message && !isMachineError(err)
		? `Could not apply this project’s settings. ${err.message}`
		: explainFailure(err, 'Could not apply this project’s settings.')
}

/** One line for a background job that ended, for the transcript and the next turn. */
function describeJobExit(job: {
	readonly jobId: string
	readonly command: string
	readonly status: 'exited' | 'killed'
	readonly exitCode?: number
	readonly signal?: string
}): string {
	const outcome =
		job.status === 'killed'
			? 'was stopped'
			: `exited ${job.exitCode ?? '?'}${job.signal ? ` (${job.signal})` : ''}`
	return `background job ${job.jobId} (${job.command}) ${outcome}`
}

function TranscriptFrame({ children }: { readonly children: React.ReactNode }) {
	// Borderless, edge-to-edge — the message glyph gutter provides structure.
	return <Box flexDirection="column">{children}</Box>
}

/**
 * The footer's key hint for the screens that have no box of their own. A
 * picker or prompt prints its hints inside its box instead (see `boxOwnsKeys`).
 */
function hintForPhase(
	phase: LifecyclePhase,
	state: 'idle' | 'thinking' | 'tool' | 'awaiting-permission',
	/** Whether the active-turn composer contains text, a paste, or an attachment. */
	hasDraft = false,
): string {
	if (phase === 'probing') return 'discovering providers…'
	if (phase === 'unhealthy') return 'esc or Ctrl+C exit'
	if (state !== 'idle') return hasDraft ? 'enter steer · tab queue · esc interrupt' : ''
	// The composer already points to /help. Keeping the complete key list in
	// every idle frame made ordinary conversation read like a permanent setup
	// screen; only state-specific actions belong in the footer.
	return ''
}

function goalStatusLabel(goal: SessionGoal | null, armed: boolean): string | null {
	if (!goal) return null
	switch (goal.phase) {
		case 'active':
			return armed ? 'Pursuing goal' : 'Goal paused (/goal resume)'
		case 'paused':
			return 'Goal paused (/goal resume)'
		case 'blocked':
			return 'Goal stalled (/goal resume)'
		case 'complete':
			return 'Goal achieved'
	}
}

/**
 * The child session a tool review came from, when it is not this
 * conversation's own turn: what names the agent asking in the prompt. Read by
 * field, because the review request names its session only when the kernel
 * attributes it.
 */
function reviewSource(
	request: object | null | undefined,
	currentSessionId: string | undefined,
): string | undefined {
	const sessionId = (request as { readonly sessionId?: unknown } | null | undefined)?.sessionId
	return typeof sessionId === 'string' && sessionId !== currentSessionId ? sessionId : undefined
}

/**
 * Whether a plain No to this question ends the turn: the person's own
 * conversation, asked about one call at a time. A whole-batch question (the
 * first look at the screen, a scheduled run's) and any other agent's request
 * are refused for that request alone.
 */
function endsTurnOnNo(pending: PendingPermission): boolean {
	return pending.perCall === true && pending.batchOnly !== true && pending.screenConsent !== true
}

/** The label the operator saw for the option id they chose. */
function labelOfOption(question: UserQuestion, optionId: string): string {
	return question.options.find((option) => option.id === optionId)?.label ?? optionId
}

/** `/agents batches`' one-line-per-batch text, mirroring `/jobs`' own column shape. */
function batchOption(batch: Batch): ChoicePickerOption {
	const agents = `${batch.agentsDone}/${batch.agentsTotal} agent${batch.agentsTotal === 1 ? '' : 's'}`
	const tokens = `${batch.tokensTotal.toLocaleString('en-US')} tokens`
	const columns = [
		relativeStart(batch.startedAt),
		batch.phases.join(', '),
		agents,
		tokens,
		formatElapsed(batch.elapsedMs),
	]
	if (batch.live) columns.push('live')
	return { label: batch.name, description: columns.join(' · ') }
}

/** `1 running, 2 finished`: the runs of the list, by whether they are still going. */
function workflowRunsSubtitle(runs: readonly Pick<WorkflowRunView, 'status'>[]): string {
	const running = runs.filter((run) => run.status === 'running').length
	return `${running} running, ${runs.length - running} finished`
}

/** The `/workflows` list's own key hints: Enter opens a run, `x` stops one that is going. */
function workflowRunsHints(canStop: boolean): { text: string; rank: number }[] {
	return [
		{ text: 'enter to view', rank: 5 },
		...(canStop ? [{ text: 'x to stop', rank: 3 }] : []),
		{ text: 'esc to close', rank: 4 },
	]
}

/** One `/workflows` row: the name, then how it stands, how many agents, when it began and how long it took. */
function workflowRunOption(run: WorkflowRunView): ChoicePickerOption {
	const counts = countAgents(run)
	const tokens = runTokens(run)
	// The word a finished run wears in the transcript, and the duration straight
	// after it, so a narrow row drops the tail rather than a number.
	const columns = [
		run.status === 'running' ? 'running' : endWord(run.status),
		formatElapsed((run.endedAt ?? Date.now()) - run.startedAt),
		workflowAgentProgress(counts),
		...(tokens > 0 ? [`${formatCompactCount(tokens)} tokens`] : []),
		relativeStart(run.startedAt),
	]
	return { label: run.name, description: columns.join(' · ') }
}

/** `just now` / `12m ago` / `3h ago` / `2d ago` — the same buckets a conversation's own resume picker shows. */
function relativeStart(startedAt: number): string {
	const minutes = Math.round((Date.now() - startedAt) / 60_000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.round(hours / 24)}d ago`
}

function choicePickerSearchable(picker: ChoicePickerState): boolean {
	return ['command', 'skill', 'plugin', 'review-branch', 'review-commit'].includes(picker.kind)
}

function loadedPluginPicker(owner: AgentSession): ChoicePickerState {
	const plugins = owner.plugins?.list() ?? []
	return {
		kind: 'plugin',
		owner,
		title: 'Plugins',
		notice: 'Loaded in this conversation · select to inspect or change state',
		values: plugins.map((plugin) => plugin.name),
		options: plugins.map(pluginOption),
	}
}

function pluginActionPicker(owner: AgentSession, name: string): ChoicePickerState | null {
	const plugin = owner.plugins?.list().find((item) => item.name === name)
	if (!plugin) return null
	const enabled = plugin.status === 'enabled'
	return {
		kind: 'plugin-action',
		owner,
		pluginName: name,
		title: `${plugin.name} · ${plugin.version}`,
		notice: `${plugin.status} · after restart: ${pluginStartupState(plugin)} · ${plugin.tools.length} tool${plugin.tools.length === 1 ? '' : 's'}`,
		values: ['details', enabled ? 'disable' : 'enable', 'remember'],
		options: [
			{
				label: 'Details',
				description: 'Show directory and contributions.',
				selectedDescription: plugin.description,
			},
			{
				label: enabled ? 'Disable for this conversation' : 'Enable for this conversation',
				description: enabled
					? 'Remove its tools, skills and hooks; disconnect its MCP servers.'
					: 'Load this trusted plugin’s tools, skills, hooks and MCP servers.',
				selectedDescription:
					'Resets on restart or model switch. Wait for the current reply to finish first.',
			},
			{
				label: `Keep ${enabled ? 'enabled' : 'disabled'} after restart`,
				description: 'Remember this state for future conversations and model switches.',
				selectedDescription:
					plugin.startupError ??
					'Applies only to this plugin directory. Other open conversations keep their state.',
				...(plugin.startupEnabled === enabled
					? { disabledReason: 'Already the startup setting.' }
					: {}),
			},
		],
	}
}

/** Why bypass cannot be entered, in the words a person can act on. */
const BYPASS_UNAVAILABLE_NOTICE =
	'Bypass mode is not available in this session. Start Namzu with --allow-dangerously-skip-permissions (or --yolo) to use it, unless permissions.disableBypassMode is set.'
const AUTO_UNAVAILABLE_NOTICE = 'Auto mode is not available in this session.'

export function permissionPicker(
	mode: PermissionMode,
	more = false,
	availability: ModeAvailability = { bypass: true, auto: true },
): Extract<ChoicePickerState, { kind: 'permission-mode' }> {
	const current = mode
	const values = more
		? (['strict', 'rules'] as const)
		: (['prompt', 'accept-edits', 'plan', 'bypass', 'classify', 'more'] as const)
	const unavailable = (value: PermissionMode): string | undefined => {
		if (value === 'bypass' && !availability.bypass) return BYPASS_UNAVAILABLE_NOTICE
		if (value === 'classify' && !availability.auto) return AUTO_UNAVAILABLE_NOTICE
		return undefined
	}
	return {
		kind: 'permission-mode',
		title: more ? 'More permission options' : 'Permissions',
		notice: `Current: ${permissionModeLabel(current)} · this conversation`,
		values,
		options: values.map((value) => {
			if (value === 'more')
				return {
					label: 'More options',
					description: 'Preapproved-only mode and permission rules',
					current: current === 'strict',
				}
			if (value === 'rules')
				return {
					label: 'View rules',
					description: 'Show the permission rules in use',
				}
			const disabledReason = unavailable(value)
			return {
				label: permissionModeLabel(value),
				description: permissionModeDescription(value),
				current: value === current,
				...(disabledReason ? { disabledReason } : {}),
			}
		}),
	}
}

/** The one-time question before the first switch into bypass. */
function bypassConsentPicker(
	announce: boolean,
): Extract<ChoicePickerState, { kind: 'bypass-consent' }> {
	return {
		kind: 'bypass-consent',
		title: BYPASS_CONSENT_TITLE,
		notice: BYPASS_CONSENT_BODY,
		announce,
		values: ['decline', 'accept'],
		options: [
			{ label: 'No, keep asking', description: 'Stay in the current mode.' },
			{
				label: 'Yes, bypass permissions',
				description: 'Remembered; you will not be asked again.',
			},
		],
	}
}

/**
 * The picker's sentinel for the hypermode row, below the rule.
 *
 * A plain string outside the `ReasoningEffort` union by construction — never
 * added to any model's published menu — so it can share the same picker
 * without ever being mistaken for a level `/effort <token>` could select.
 */
const HYPERMODE_VALUE = 'hypermode' as const

/** ` · save as skill` when queued messages carry composer triggers, so the queue line says so. */
function queuedTriggerLabels(queued: readonly QueuedPrompt[]): string {
	const labels = new Set<string>()
	for (const prompt of queued) {
		if (prompt.kind !== 'human') continue
		for (const id of prompt.triggers ?? []) labels.add(triggerDefinition(id).label)
	}
	return labels.size > 0 ? ` · ${[...labels].join(', ')}` : ''
}

/** Last entry of a low-to-high menu every provider publishes in that order; `undefined` when none is known. */
function highestReasoningEffort(
	levels: readonly ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
	return levels && levels.length > 0 ? levels[levels.length - 1] : undefined
}

function reasoningEffortPicker(
	session: AgentSession,
	current: ReasoningEffort | undefined,
	afterModelSelection = false,
	hypermodeOn = false,
): Extract<ChoicePickerState, { kind: 'reasoning-effort' }> | undefined {
	const levels = session.reasoningEffortLevels
	if (!session.hasProvider || levels === undefined) return undefined
	const effortValues: readonly (ReasoningEffort | undefined)[] = [undefined, ...levels]
	const values: readonly (ReasoningEffort | undefined | typeof HYPERMODE_VALUE)[] = [
		...effortValues,
		HYPERMODE_VALUE,
	]
	return {
		kind: 'reasoning-effort',
		title: `Select Reasoning Level for ${session.modelSummary ?? 'current model'}`,
		...(afterModelSelection
			? {
					selectedSession: session,
					notice: 'Model selected. Esc keeps this model at its default effort.',
				}
			: {}),
		values,
		options: [
			...effortValues.map((effort) => ({
				label: effort ?? 'default',
				description: reasoningEffortDescription(effort),
				current: effort === current,
				default: effort === undefined,
			})),
			{
				// Below a rule, visually apart from the levels above: a session
				// setting, not a sixth level the provider published. The label
				// names the level it pins, then the mode.
				label: HYPERMODE_ROW_LABEL,
				description: `${hypermodeOn ? 'On' : 'Off'} · ${HYPERMODE_SUMMARY}`,
				current: hypermodeOn,
				ruleBefore: true,
			},
		],
	}
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
			return 'Highest reasoning setting, when the model supports it'
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
	return compactionSummaryLines(typeof summary.content === 'string' ? summary.content : '')
}
