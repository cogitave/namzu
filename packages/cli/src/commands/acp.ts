import {
	ACPServer,
	type AcpAgentGateway,
	type AcpHostKernelFacts,
	type ComputerUseObservation,
	DiskSessionLog,
	type ExternalRefTarget,
	HostCommandRegistry,
	type Message,
	type MustAskCall,
	type Origin,
	type PalEnvironmentLease,
	ServerStdioTransport,
	type SessionEvent,
	type SessionId,
	type ToolPresenter,
	abandonTurn,
	asSessionId,
	asTurnId,
	createUserMessage,
	generateSessionId,
	generateTurnId,
	genericLabel,
	isEntityId,
	newPasteNonce,
	openSessionIndex,
} from '@namzu/sdk'
import { limitsSources } from '../integrations/limits/sources.js'
import { type LimitsFeed, createLimitsFeed } from './desktop-limits-feed.js'
import { localSpendEstimate } from './desktop-limits-spend.js'

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	advertisedPromptModes,
	bypassOptedIn,
	computerUseEnabled,
	hypermodeRefusal,
	sessionOptionsFromConfig,
	turnOptionsFromConfig,
} from '../config/session-options.js'
import {
	IdleCompactor,
	type IdleCompactorDeps,
} from '../integrations/compaction/idle-compaction.js'

import { FileCheckpointStore, type TurnUndoStatus, type UndoPreview } from '../checkpoints/store.js'
import { flushCompileCacheWhenIdle } from '../compile-cache.js'
import { SET_SETTING_TOOL } from '../config/agent-settings-tools.js'
import type { AgentSettingsContext, DesktopPreferences } from '../config/agent-settings.js'
import { describeAgentChange } from '../config/agent-settings.js'
import type { SkillsConfig } from '../config/schema.js'
import {
	refreshTrustedProjectContext,
	resolveTrustedProjectContext,
} from '../config/trusted-project-context.js'
import { messageTimeNote, previousSentAt } from '../context/message-time.js'
import { DESKTOP_CONTRACT } from '../desktop-contract.js'
import { accountForProvider } from '../integrations/accounts/binding.js'
import { type PluginInventoryView, readPluginInventory } from '../integrations/plugins/inventory.js'
import { canSelectModel } from '../integrations/providers/access.js'
import {
	type ComposerModelSettings,
	validateComposerSendSettings,
} from '../integrations/providers/composer-settings.js'
import {
	type ProviderConnection,
	listProviderConnections,
	removeProviderKey,
	saveProviderKey,
	typedKeyProvider,
} from '../integrations/providers/connections.js'
import {
	automaticKind,
	discoverProviders,
	isAnonymousZen,
} from '../integrations/providers/discover.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { isOfferableModel } from '../integrations/providers/zen-catalogue.js'
import { discoverContextLists, gatherContext } from '../integrations/sessions/context-gather.js'
import {
	type CliSessionScope,
	closeSessions,
	loadConversation,
	loadResumableConversation,
	openSessionScope,
	openSessions,
	readConversationFacts,
	recordGeneratedTitle,
	titlesOf,
} from '../integrations/sessions/store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { cliProjectRoot } from '../integrations/state/project.js'
import { isTrustedAtStateRoot } from '../integrations/trust/store.js'
import { cliLogger } from '../logging.js'
import { palSessionEnvironment } from '../pals/agent-session.js'
import { palConversationBinding } from '../pals/conversations.js'
import { closeCliPalRuntime, getCliPalRuntime } from '../pals/environment.js'
import { type CliPalInboxStarter, createPalInboxStarter } from '../pals/inbox-start.js'
import { palAtWorkspace } from '../pals/store.js'
import { compileBrowserSites, withBrowserSiteRules } from '../permissions/browser-sites.js'
import { canonicalProjectPath } from '../permissions/canonical-project.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { launchRefusal } from '../permissions/launch.js'
import type { PermissionMode } from '../permissions/mode.js'
import {
	compilePermissionLayers,
	permissionLayersOf,
	warnLegacyMcpPermissionNames,
} from '../permissions/rules.js'
import type { PermissionSettings } from '../permissions/settings.js'
import { resolveProgressNudge } from '../reminders/progress-nudge.js'
import { type TerminalHost, createTerminalHost } from '../terminal/host.js'
import {
	type AgentSession,
	createAgentSession,
	describeProviderModels,
	describeProviderReasoning,
	probeAgentSession,
	verifyCredential,
} from '../tui/agent.js'
import { displayPath } from '../tui/display-path.js'
import { withCliHarnesses } from './acp-harness.js'
import {
	type ProviderRetryStatus,
	readProviderRetryStatus,
	settleTurnOfGoneHost,
} from './acp-provider-retry.js'
import { questionsOverPermission } from './acp-screen-question.js'
import {
	COMMIT_MESSAGE_INSTRUCTION,
	type CommitMessageRequest,
	commitMessageBody,
} from './desktop-commit.js'
import { COMPUTER_FRAME_NOTIFICATION } from './desktop-computer-feed.js'
import {
	type ContextDetail,
	type ContextReport,
	buildContextReport,
	createContextTracker,
} from './desktop-context.js'
import {
	createExtensionsRpc,
	sharedExtensionHost,
	startDesktopExtensions,
	stopDesktopExtensions,
} from './desktop-extensions.js'
import { createDesktopHostExtensions } from './desktop-host.js'
import { desktopModelCatalogue } from './desktop-model-catalogue.js'
import { announceOutcome } from './desktop-outcome-feed.js'
import { desktopPreferencesBridge } from './desktop-preferences.js'
import { createTitleFeed } from './desktop-title-feed.js'
import { type UsageFeed, createUsageFeed } from './desktop-usage-feed.js'
import { withPreviews } from './permission-preview.js'
import type { CommandContext, CommandDef } from './types.js'

/** Same read as `cli.ts`'s `--version`: the manifest, never a second copy. */
/**
 * A failure a person reads, with a stable code a front end can map to its own wording. The
 * sentence is plain on its own, for front ends that show it as is; the code travels as the
 * JSON-RPC error's `data.code`.
 */
function engineFailure(code: string, message: string): Error {
	return Object.assign(new Error(message), { data: { code } })
}

function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
			version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

/** The account the saved chain pins for a provider, as a member field: a model pick keeps it. */
function accountPin(
	preferences: Preferences | null | undefined,
	provider: string,
): { readonly account: string } | Record<string, never> {
	const account = preferences ? accountForProvider(preferences, provider) : undefined
	return account !== undefined ? { account } : {}
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first
		? {
				version: 3,
				providers: [{ id: first.entry.id }],
				subagents: { active: [] },
			}
		: null
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise<T>((resolve, reject) => {
		let active = true
		const finish = () => {
			if (!active) return false
			active = false
			signal.removeEventListener('abort', onAbort)
			return true
		}
		const onAbort = () => {
			if (finish()) reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		operation.then(
			(value) => {
				if (finish()) resolve(value)
			},
			(error) => {
				if (finish()) reject(error)
			},
		)
	})
}

/**
 * `namzu acp` — the agent-client protocol over this process's stdio.
 *
 * This command exists in the same change as the bridge it drives, and that
 * is the point rather than a convenience. `MCPServer` and
 * `ServerStdioTransport` are both exported from this SDK and nothing in the
 * tree ever constructed an `MCPServer`: a complete protocol server with no
 * driver, which reads as a supported feature and is not one. A subprocess
 * test spawns this binary, so removing the registration below fails a test
 * rather than quietly shipping the same shape twice.
 *
 * **stdout belongs to the protocol.** Everything this command prints for a
 * human goes to stderr. The SDK's logger already writes there; what this
 * file must not do is `console.log`, and a test asserts zero non-JSON bytes
 * on the child's stdout under info-level logging.
 */

/** The namzu session one ACP wire session id stands for. */
export interface AcpSessionTarget {
	readonly sessionId: SessionId
	/** Present when the session is new: recorded in `session_started.origin`. */
	readonly origin?: Origin
}

/** How a caller-side name is looked up (`SessionIndex.resolveExternal`). */
export type ExternalSessionLookup = (
	protocol: 'acp',
	kind: 'session',
	externalId: string,
) => Promise<ExternalRefTarget | undefined>

/**
 * Map an ACP wire session id onto a namzu session (spec §5.3).
 *
 * The SDK's server mints a UUIDv7 `SessionId` by default, and that id IS the
 * namzu session. A host's `newSessionId` may return any string; such an id
 * is never read as a namzu id. It is looked up in the index's
 * `external_refs('acp', 'session', id)`, and a name nobody has claimed gets a
 * new session whose `session_started.origin` records it — which is what puts
 * the ref in the index, so it survives a rebuild and the next connection
 * finds the same session.
 */
export async function resolveAcpSession(
	wireSessionId: string,
	lookup: ExternalSessionLookup,
): Promise<AcpSessionTarget> {
	if (isEntityId(wireSessionId, 'session')) return { sessionId: wireSessionId }
	const found = await lookup('acp', 'session', wireSessionId)
	if (found) return { sessionId: found.sessionId }
	return {
		sessionId: generateSessionId(),
		origin: { protocol: 'acp', externalSessionId: wireSessionId },
	}
}

/** Open the index under `NAMZU_HOME` for one lookup and close it again. */
async function lookupInIndex(
	protocol: 'acp',
	kind: 'session',
	externalId: string,
): Promise<ExternalRefTarget | undefined> {
	const index = await openSessionIndex()
	try {
		return await index.resolveExternal(protocol, kind, externalId)
	} finally {
		index.close()
	}
}

type AcpLiveSession = Pick<
	AgentSession,
	| 'hasProvider'
	| 'errorHint'
	| 'mcpFailed'
	| 'mcpStatus'
	| 'send'
	| 'close'
	| 'presenter'
	| 'jobs'
	| 'readJob'
	| 'stopJob'
	| 'monitors'
	| 'plugins'
	| 'reasoningEffortLevels'
	| 'reasoningEffortDefault'
	| 'imageAttachmentsSupported'
	| 'documentAttachmentsSupported'
	| 'checkpoints'
	| 'markFilesChanged'
	| 'autoMode'
	| 'sideModel'
	| 'clearStaleResultsAfterIdle'
> & {
	/** Records a mode change on the turn running now (the log and the model's one-time notice). */
	readonly setPermissionMode?: AgentSession['setPermissionMode']
	readonly resumePaused?: AgentSession['resumePaused']
	readonly abandonTurn?: AgentSession['abandonTurn']
	readonly describeComputerUseCall?: AgentSession['describeComputerUseCall']
	/** What the context panel sizes; a fake session may leave them out. */
	readonly contextInventory?: AgentSession['contextInventory']
	readonly instructionFiles?: AgentSession['instructionFiles']
}

export interface AcpRuntimeDependencies {
	readonly palBinding?: typeof palConversationBinding
	readonly palRuntime?: typeof getCliPalRuntime
	readonly probe: typeof probeAgentSession
	readonly describeModels?: typeof describeProviderModels
	readonly verifyKey?: typeof verifyCredential
	readonly describeReasoning?: typeof describeProviderReasoning
	readonly readPlugins?: typeof readPluginInventory
	readonly createSession: (
		preferences: Preferences,
		detected: readonly DetectedProvider[],
		options: Parameters<typeof createAgentSession>[2],
	) => Promise<AcpLiveSession>
	readonly decideTrust: typeof decideHeadlessTrust
	readonly resolveProjectContext: typeof resolveTrustedProjectContext
	/** The project's context with its files read again: a new conversation takes the saved settings. */
	readonly refreshProjectContext?: typeof refreshTrustedProjectContext
	/** Which namzu session a wire session id stands for; see {@link resolveAcpSession}. */
	readonly resolveSession: (wireSessionId: string) => Promise<AcpSessionTarget>
	/** Durable CLI catalog owned for the lifetime of one runtime session. */
	readonly openSessions?: typeof openSessions
	/** Direct journal reads; legacy injected openSessions remains the fallback when absent. */
	readonly openSessionScope?: typeof openSessionScope
	readonly readRetryStatus?: typeof readProviderRetryStatus
}

/**
 * The prompt-cache clock of one conversation, used only to shed old tool
 * results after a long break (`compaction.clearStaleResultsAfterIdle`). The
 * idle compaction timer is the terminal's; nothing here ever arms it.
 */
function staleResultsDeps(sessionId: string): IdleCompactorDeps {
	return {
		now: Date.now,
		setTimer: () => undefined,
		clearTimer: () => undefined,
		isEnabled: () => false,
		conversationKey: () => sessionId,
		minTokens: () => Number.POSITIVE_INFINITY,
		contextTokens: () => undefined,
		isNearLimit: () => false,
		lastInteractionAt: () => 0,
		isTurnRunning: () => false,
		isDialogOpen: () => false,
		hasPendingWake: () => false,
		hasBackgroundWork: () => false,
		compact: async () => false,
	}
}

interface AcpRuntimeRecord {
	readonly conversations?: Awaited<ReturnType<typeof openSessions>>
	readonly cwd: string
	readonly session: AcpLiveSession
	/** Host-validated Pal binding, never a wire-supplied scope claim. */
	readonly ownedPal: boolean
	readonly palId?: string
	readonly readyComputer?: () => PalEnvironmentLease | undefined
	readonly provider: string
	/** What the configuration decides about every turn of this conversation (hypermode, refusal fallback). */
	readonly turnOptions: ReturnType<typeof turnOptionsFromConfig>
	/** `workflow.enabled: false`: a hypermode asked for in the composer is refused, not sent. */
	readonly workflowsOff?: true
	/** Tracks the prompt cache across turns, to shed old tool results once it has lapsed. */
	readonly staleResults: IdleCompactor
	/** The skills settings this conversation started with, for the context panel's skill list. */
	readonly skillsConfig?: SkillsConfig
	/** `permissions.disableBypassMode` and friends, which the host cannot be talked out of. */
	readonly permissionSettings?: PermissionSettings
	/** The model this connection runs on now; a retry repeats the paused turn on it, not on the failed one. */
	readonly model: string
	/**
	 * The mode the turn running now decides its calls under, read at every decision. Set while a
	 * turn runs and cleared when it ends; a change made meanwhile writes `mode`.
	 */
	liveMode?: { mode: PermissionMode }
	retrySettings?: {
		turnId: string
		settings: ReturnType<typeof validateComposerSendSettings>
		computer?: { generation: number; environmentId: string }
	}
	route: ((event: SessionEvent) => void) | undefined
}

/**
 * Whether this conversation may run in `mode`. The Desktop's own confirmation
 * is the person's consent to bypass, so there is no launch flag to look for;
 * what the settings shut and the root guard still hold, and the auto mode
 * needs a model it can ask.
 */
function assertModeAllowed(record: AcpRuntimeRecord, mode: PermissionMode): void {
	const refusal = launchRefusal(mode, { settings: record.permissionSettings })
	if (refusal) throw new Error(refusal)
	if (mode === 'bypass' && !bypassOptedIn(record.permissionSettings)) {
		throw new Error(
			'The mode that skips every question is off. Turn on Allow bypass permissions mode in Settings first.',
		)
	}
	if (mode === 'classify' && record.session.autoMode?.available === false) {
		throw new Error(record.session.autoMode.reason ?? 'Auto mode is not available here.')
	}
}

const MISSING_RETRY_COMPUTER =
	'The original Pal computer lifetime cannot be verified. This checkpoint is retained; Retry cannot attach it to a new computer.'
const CHANGED_RETRY_COMPUTER =
	'The original Pal computer is unavailable, changed or under operator control. This checkpoint is retained.'
function readyComputerPin(record: AcpRuntimeRecord) {
	const lease = record.readyComputer?.()
	return lease &&
		lease.palId === record.palId &&
		(lease.sandbox.status === 'ready' || lease.sandbox.status === 'busy') &&
		Number.isSafeInteger(lease.generation) &&
		lease.generation > 0 &&
		typeof lease.environmentId === 'string' &&
		lease.environmentId.length > 0
		? { generation: lease.generation, environmentId: lease.environmentId }
		: undefined
}
function assertRetryComputer(
	record: AcpRuntimeRecord,
	original: AcpRuntimeRecord['retrySettings'],
) {
	if (!record.ownedPal) return
	const pin = original?.computer
	if (!pin) throw new Error(MISSING_RETRY_COMPUTER)
	const current = readyComputerPin(record)
	if (
		!current ||
		current.generation !== pin.generation ||
		current.environmentId !== pin.environmentId
	)
		throw new Error(CHANGED_RETRY_COMPUTER)
}

/** What a client sends to apply an undo; already validated for shape. */
export interface TurnUndoRequest {
	readonly turnId: string
	readonly planToken: string
	readonly resolutions?: Readonly<Record<string, 'skip' | 'keep_copy'>>
	readonly alsoUndoLater?: boolean
}

export interface TurnUndoResult {
	readonly turnId: string
	/** `plan-changed` means nothing was written: `replan` is what to show instead. */
	readonly status: 'applied' | 'undone' | 'partially_undone' | 'plan-changed'
	readonly files: Readonly<Record<string, string>>
	/** Later replies undone along with it, by turn id. */
	readonly later?: Readonly<Record<string, Readonly<Record<string, string>>>>
	/** Files the operator had changed, saved before being replaced. */
	readonly copies?: readonly { path: string; sha256: string }[]
	readonly replan?: UndoPreview
}

/**
 * Undo a reply's file changes. Reads and writes the conversation's
 * `file-history/` and the disk only: a conversation nobody has opened in this
 * process is undone without building a model session.
 */
export interface CliTurnUndo {
	status(
		sessionId: string,
		cwd: string,
		scope: CliSessionScope,
		turnIds?: readonly string[],
	): Promise<{ turns: TurnUndoStatus[] }>
	preview(
		sessionId: string,
		cwd: string,
		scope: CliSessionScope,
		turnId: string,
		options?: { alsoUndoLater?: boolean },
	): Promise<UndoPreview>
	undo(
		sessionId: string,
		cwd: string,
		scope: CliSessionScope,
		request: TurnUndoRequest,
	): Promise<TurnUndoResult>
}

export interface CliAcpRuntime {
	readonly gateway: AcpAgentGateway
	/**
	 * The small model's commit message for a conversation's changed files, or undefined when it has
	 * none or cannot answer. Counted like any side request; never asked without a person's click.
	 */
	suggestCommitMessage?(
		sessionId: string,
		request: CommitMessageRequest,
		signal: AbortSignal,
	): Promise<string | undefined>
	/** Per-reply file undo; absent on a runtime that keeps no file history. */
	readonly turnUndo?: CliTurnUndo
	/** Live operator text for this connection's current ordinary Namzu prompt only. */
	liveInputStatus?(
		sessionId: string,
		scopeId?: string,
		scope?: CliSessionScope,
	): Promise<CliLiveInputStatus>
	liveInput?(
		sessionId: string,
		input: { scopeId: string; inputId: string; prompt: string },
		scope?: CliSessionScope,
	): Promise<{ accepted: true; scopeId: string; inputId: string }>
	providerStatus(sessionId?: string): Promise<unknown>
	/** Every provider this build can use, and whether this machine has one connected. */
	providerConnections(): Promise<{ providers: ProviderConnection[] }>
	/** Save a pasted key privately and forget the cached provider list. */
	saveProviderKey(provider: string, apiKey: string): Promise<{ saved: true }>
	removeProviderKey(provider: string): Promise<{ removed: true }>
	/** A cheap authenticated call; never a model turn. */
	/** Forget the cached provider list so the next read sees keys saved by another connection. */
	refreshProviders(): Promise<{ refreshed: true }>
	testProvider(provider: string): Promise<{
		status: 'ok' | 'rejected' | 'unchecked' | 'missing'
		/** Why an unchecked key learned nothing, when the provider's answer says. */
		cause?: 'quota' | 'busy' | 'down' | 'no-answer'
	}>
	/** The optional scope is a host-authenticated handoff, never a wire-supplied ownership claim. */
	providerRetryStatus?(
		sessionId: string,
		cwd: string,
		scope?: CliSessionScope,
	): Promise<ProviderRetryStatus>
	/**
	 * Close the conversation's paused provider turn without repeating it (`turn_failed`, code
	 * `abandoned`), so the next message starts a new turn. Whatever the stopped request may have
	 * cost stays recorded as unknown. Refuses a turn that waits for a person's decision. The turn's
	 * messages leave the context the next turn carries (the client puts the person's message back
	 * in its message box), while the log keeps them.
	 */
	abandonPausedTurn?(
		sessionId: string,
		cwd: string,
		turnId?: string,
		options?: { readonly withdrawMessages?: boolean },
	): Promise<{ closed: true }>
	modelSettings(provider: string, model: string, sessionId?: string): Promise<ComposerModelSettings>
	plugins(cwd: string, sessionId?: string): Promise<PluginInventoryView>
	/**
	 * Which tool servers the conversations open in this project have connected, and which one
	 * failed the last time one started. Empty when nothing has started yet.
	 */
	mcpStatus?(cwd: string): {
		readonly connected: readonly string[]
		readonly failed: readonly {
			readonly name: string
			readonly reason: string
			/** The server's settings when it failed; a failure of settings since changed is not shown. */
			readonly config?: string
		}[]
	}
	setPluginEnabled(
		sessionId: string,
		name: string,
		enabled: boolean,
		cwd?: string,
	): Promise<PluginInventoryView>
	models(
		provider: string,
		sessionId?: string,
	): Promise<{
		models: { id: string; label: string; note?: string }[]
		notice: string | null
	}>
	selectProvider(sessionId: string, provider: string, model?: string): Promise<void>
	/**
	 * Make Auto (per-task model routing) what this conversation runs on. Refused with a plain
	 * sentence when no `routing` block is configured, for a Pal, and while the conversation has
	 * active work. Absent on a runtime that cannot route.
	 */
	selectAuto?(sessionId: string): Promise<void>
	/**
	 * Where this conversation's context window goes (the desktop's context panel). Null before the
	 * engine has reported a window. `full` also lists the tool server tools, skills, agents and notes.
	 */
	contextUsage?(sessionId: string, detail: ContextDetail): Promise<ContextReport | null>
	/**
	 * Changes the mode of the conversation's running turn now, so the next call it makes is decided
	 * under `mode`. Refuses a mode the settings close, in plain words. With no turn running it only
	 * checks the mode: the next message carries it.
	 */
	setPermissionMode?(
		sessionId: string,
		mode: PermissionMode,
	): Promise<{ mode: PermissionMode; applied: 'now' | 'next-message' }>
	jobs(sessionId: string): readonly import('@namzu/sdk').BackgroundJob[]
	readJob(sessionId: string, jobId: string): unknown
	stopJob(sessionId: string, jobId: string): Promise<unknown>
	/**
	 * Delegates to whichever session's own event is being rendered RIGHT NOW
	 * — never "whichever session's `prompt` call is live", which two
	 * concurrent prompts both are. `record.route` (see `gateway.prompt`
	 * below) wraps the SDK's `onEvent` so that `activeRecord` is set to
	 * `record` for exactly the synchronous span of that one call: `update.ts`
	 * reads `presenter` synchronously while building the update it emits, so
	 * bracketing the call this tightly, rather than for the whole turn, is
	 * what keeps a second session's prompt — live at the same time — from
	 * ever being read as "active" while this event is presented. Falls back
	 * to the generic label/view before any turn has run. Was permanently a
	 * presenter over an empty, never-populated registry; every ACP
	 * tool-call/result view fell back to the generic label for every tool,
	 * every session (fixed here, not in the SDK: `ACPServerConfig.presenter`
	 * is one value for the whole server, not per session, so this is the
	 * best a CLI-side fix can do without also changing that surface).
	 */
	readonly presenter: ToolPresenter
	close(): Promise<void>
}

export interface CliLiveInputStatus {
	available: boolean
	scopeId?: string
	inputs: { id: string; status: 'pending' | 'delivered' }[]
}

/** A bounded, turn-local mailbox; closing retains receipts, never carries input forward. */
class LivePromptInbox {
	readonly scopeId = randomUUID()
	private readonly entries = new Map<string, { prompt: string; status: 'pending' | 'delivered' }>()
	private readonly waiters = new Set<{ wake: () => void; close: () => void }>()
	private chars = 0
	private open = true

	constructor(
		readonly record: AcpRuntimeRecord,
		readonly root: string,
		private readonly active: () => boolean,
	) {}

	get available(): boolean {
		return this.open && this.active()
	}
	status(): CliLiveInputStatus {
		return {
			available: this.available,
			scopeId: this.scopeId,
			inputs: [...this.entries].map(([id, entry]) => ({
				id,
				status: entry.status,
			})),
		}
	}
	accept(input: { scopeId: string; inputId: string; prompt: string }) {
		if (!this.available || input.scopeId !== this.scopeId)
			throw engineFailure('message-not-sent', 'Your message wasn’t sent. Send it again.')
		if (
			typeof input.inputId !== 'string' ||
			!input.inputId.trim() ||
			input.inputId.length > 400 ||
			[...input.inputId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
			typeof input.prompt !== 'string' ||
			!input.prompt.trim()
		)
			throw new Error('Invalid live input.')
		const previous = this.entries.get(input.inputId)
		if (previous && previous.prompt !== input.prompt)
			throw new Error('This live input id already belongs to a different message.')
		if (!previous) {
			if (this.entries.size >= 20 || this.chars + input.prompt.length > 1_000_000)
				throw engineFailure(
					'too-many-messages',
					'Namzu is busy with too many messages. Wait a moment, then send again.',
				)
			this.entries.set(input.inputId, {
				prompt: input.prompt,
				status: 'pending',
			})
			this.chars += input.prompt.length
			for (const waiter of [...this.waiters]) waiter.wake()
		}
		return {
			accepted: true as const,
			scopeId: this.scopeId,
			inputId: input.inputId,
		}
	}
	drain = (): Message[] => {
		if (!this.available) return []
		const messages: Message[] = []
		for (const entry of this.entries.values()) {
			if (entry.status !== 'pending') continue
			messages.push(createUserMessage(entry.prompt))
			entry.status = 'delivered'
		}
		return messages
	}
	wait = (signal: AbortSignal): Promise<void> => {
		if (signal.aborted) return Promise.reject(signal.reason)
		if (!this.available) return Promise.reject(new Error('The live prompt has closed.'))
		if ([...this.entries.values()].some((entry) => entry.status === 'pending'))
			return Promise.resolve()
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.waiters.delete(waiter)
				signal.removeEventListener('abort', abort)
			}
			const waiter = {
				wake: () => {
					cleanup()
					resolve()
				},
				close: () => {
					cleanup()
					reject(new Error('The live prompt has closed.'))
				},
			}
			const abort = () => {
				cleanup()
				reject(signal.reason)
			}
			this.waiters.add(waiter)
			signal.addEventListener('abort', abort, { once: true })
		})
	}
	close(): void {
		this.open = false
		for (const waiter of [...this.waiters]) waiter.close()
	}
}

const DEFAULT_RUNTIME_DEPS: AcpRuntimeDependencies = {
	palBinding: palConversationBinding,
	palRuntime: getCliPalRuntime,
	openSessions,
	openSessionScope,
	probe: probeAgentSession,
	createSession: createAgentSession,
	decideTrust: decideHeadlessTrust,
	resolveProjectContext: resolveTrustedProjectContext,
	refreshProjectContext: refreshTrustedProjectContext,
	resolveSession: (wireSessionId) => resolveAcpSession(wireSessionId, lookupInIndex),
}

/**
 * Owns the CLI runtime behind one ACP connection.
 *
 * The wire server owns IDs, cwd, cancellation and history. This owner mirrors
 * that boundary into the model runtime: one AgentSession and event route per
 * wire session, never one mutable connection-global slot.
 */
export interface CliAcpRuntimeOptions {
	/**
	 * Mount the host `computer_use` tool in each conversation. The desktop
	 * application sets it; a bare `namzu acp` client does not, so its
	 * behaviour is unchanged. Every call still goes through the person's
	 * approval, and a Pal conversation keeps its own computer instead.
	 */
	readonly computerUse?: boolean
	/**
	 * Sees every session event of a conversation, with its wire session id, after
	 * the protocol bridge has had it. The desktop host reads usage and compaction
	 * here, which the shared bridge leaves out. It must not throw or wait.
	 */
	readonly observeEvent?: (sessionId: string, event: SessionEvent) => void
	/**
	 * Sees what the model saw after a `computer_use` call, made small, with its wire
	 * session id. The desktop host shows it beside the call. It must not throw or wait.
	 */
	readonly observeComputer?: (sessionId: string, observation: ComputerUseObservation) => void
	/**
	 * Says a `namzu/` notification to the desktop. When set, the host names each new conversation
	 * with the small model, beside its first turn, and tells the desktop the name.
	 */
	readonly announce?: (method: string, params: Record<string, unknown>) => void
	/** How the desktop app's own preferences are reached; absent when the app did not say. */
	readonly desktopPreferences?: DesktopPreferences
}

export function createCliAcpRuntime(
	bootstrapCtx: CommandContext,
	deps: AcpRuntimeDependencies = DEFAULT_RUNTIME_DEPS,
	runtimeOptions: CliAcpRuntimeOptions = {},
): CliAcpRuntime {
	const records = new Map<string, AcpRuntimeRecord>()
	const contextTracker = createContextTracker()
	// What was read from disk for the context panel, until the next turn or shortening ends.
	const contextReads = new Map<
		string,
		{
			version: number
			lists: Awaited<ReturnType<typeof discoverContextLists>>
			files: Map<string, string>
		}
	>()
	// The tool servers that stopped the last conversation from starting in a folder. A session whose
	// server failed never exists, so this is the only place the reason survives for a settings page.
	const mcpFailures = new Map<string, readonly { name: string; reason: string; config: string }[]>()
	const mcpKey = (dir: string): string => {
		try {
			return canonicalProjectPath(dir)
		} catch {
			return dir
		}
	}
	/** What the settings tools read and write for a conversation in `cwd`. */
	const settingsContext = (cwd: string): AgentSettingsContext => ({
		cwd,
		...(runtimeOptions.desktopPreferences ? { desktop: runtimeOptions.desktopPreferences } : {}),
	})
	const liveInputs = new Map<string, LivePromptInbox>()
	const constructing = new Map<string, string>()
	const selections = new Map<string, Preferences>()
	// Auto is available when the user config has a `routing` block and the default when it also says
	// `model: auto`. This holds the person's choice per conversation: true after choosing Auto, false
	// after hand-picking a model. Never persisted into startup config.
	const autoChoices = new Map<string, boolean>()
	const autoAvailable = (config: { readonly routing?: unknown }, pal: boolean) =>
		config.routing !== undefined && !pal
	const autoIsActive = (
		sessionId: string | undefined,
		config: { readonly routing?: unknown; readonly model?: string },
		pal: boolean,
	) =>
		autoAvailable(config, pal) &&
		((sessionId ? autoChoices.get(sessionId) : undefined) ?? config.model === 'auto')
	// Explicit changes belong to the wire conversation, including when a model
	// change reconstructs its runtime. Never persist these into startup config.
	const pluginOverrides = new Map<string, Map<string, boolean>>()
	const selecting = new Set<string>()
	/**
	 * The approval settings of a paused turn, kept across a model change: choosing another model closes
	 * the live session but not the paused turn, and Retry on the new model needs the same settings.
	 */
	/** The provider and model each paused turn was last retried on, for naming what stopped it again. */
	const retriedOn = new Map<string, { provider: string; model: string }>()
	const retryCarry = new Map<string, AcpRuntimeRecord['retrySettings']>()
	// Conversations an undo is writing into right now: no prompt may start under it.
	const undoing = new Set<string>()
	// What an undo changed, for the model's next turn in that conversation. Keyed
	// by session, not record: a conversation undone cold has no record yet.
	const undoNotes = new Map<string, string[]>()
	// Cold undo stores of one conversation run one at a time: two stores over one
	// directory would each sweep and write from a stale picture of the other.
	const undoTails = new Map<string, Promise<void>>()
	const titleFeed = runtimeOptions.announce
		? createTitleFeed({
				notify: runtimeOptions.announce,
				sideModel: (id) => records.get(id)?.session.sideModel,
				hasTitle: async (id) => {
					const record = records.get(id)
					if (!record?.conversations || record.ownedPal) return true
					const target = await deps.resolveSession(id)
					const titles = await titlesOf(record.conversations, target.sessionId)
					return titles.named !== undefined || titles.generated !== undefined
				},
				idle: (id) => records.get(id)?.route === undefined,
				save: async (id, title) => {
					const record = records.get(id)
					if (!record?.conversations) return
					const target = await deps.resolveSession(id)
					await recordGeneratedTitle(record.conversations, target.sessionId, title)
				},
			})
		: undefined
	const catalogueController = new AbortController()
	const catalogueRequests = new Map<string, ReturnType<typeof describeProviderModels>>()
	let probePromise: ReturnType<typeof probeAgentSession> | undefined
	let closed = false
	// The record whose event `toAcpSessionUpdate` is presenting RIGHT NOW —
	// set only for the synchronous span of one `record.route(event)` call
	// (see `gateway.prompt`), never for a whole turn, so two turns in flight
	// at once cannot read each other's record while presenting their own
	// event.
	let activeRecord: AcpRuntimeRecord | undefined
	const assertLiveOwner = (
		sessionId: string,
		inbox: LivePromptInbox,
		scope?: CliSessionScope,
	): void => {
		if (closed || records.get(sessionId) !== inbox.record)
			throw new Error('This live prompt owner is no longer available.')
		const trust = deps.decideTrust({ cwd: inbox.record.cwd, trustFlag: false })
		if (!trust.allowed || trust.cwd !== inbox.record.cwd || resolveNamzuHome() !== inbox.root)
			throw new Error('This live prompt no longer owns the trusted project and application home.')
		if (scope) {
			const admitted = inbox.record.conversations
			if (
				!admitted ||
				scope.root !== admitted.root ||
				scope.projectRoot !== admitted.projectRoot ||
				scope.projectId !== admitted.projectId ||
				scope.tenantId !== admitted.tenantId ||
				scope.topicId !== admitted.topicId ||
				scope.paths.home !== admitted.paths.home ||
				scope.paths.slug !== admitted.paths.slug
			)
				throw new Error('This live prompt does not belong to the admitted session scope.')
		}
	}
	const presenter: ToolPresenter = {
		presentCall: (toolName, input) =>
			activeRecord?.session.presenter.presentCall(toolName, input) ?? {
				kind: 'generic',
				label: genericLabel(input),
			},
		presentResult: (toolName, input, result) =>
			activeRecord?.session.presenter.presentResult(toolName, input, result) ?? {
				kind: 'generic',
				label: genericLabel(input),
			},
	}

	const sharedProbe = () => {
		if (!probePromise) {
			probePromise = deps.probe().catch((error) => {
				probePromise = undefined
				throw error
			})
		}
		return probePromise
	}
	const openReadScope = async (cwd: string, root: string) => {
		if (deps.openSessionScope)
			return { state: await deps.openSessionScope(cwd, { stateRoot: root }), close: () => {} }
		// An embedding's existing storage seam must not silently switch homes.
		if (deps.openSessions) {
			const state = await deps.openSessions(cwd)
			return { state, close: () => closeSessions(state) }
		}
		return { state: await openSessionScope(cwd, { stateRoot: root }), close: () => {} }
	}
	const assertReadTrust = (cwd: string, state: CliSessionScope) => {
		const current = deps.decideTrust({
			cwd,
			trustFlag: false,
			trusted: (dir) => isTrustedAtStateRoot(dir, state.root),
		})
		if (!current.allowed) throw new Error(current.message ?? 'Trust this folder first.')
		if (current.cwd !== cwd)
			throw new Error('The project changed while its conversation scope was opening.')
	}
	const preferencesFor = async (
		sessionId: string | undefined,
		probe: Awaited<ReturnType<typeof probeAgentSession>>,
		cwd = process.cwd(),
	) => {
		const selected = sessionId ? selections.get(sessionId) : undefined
		if (selected) return selected
		const base = probe.preferences ?? defaultPrefs(probe.detected)
		const binding = sessionId ? await deps.palBinding?.(cwd, sessionId) : null
		if (!binding?.definition.model) return base
		const profile = binding.definition.model
		const entry = probe.detected.find(({ entry }) => entry.id === profile.provider)?.entry
		if (!entry) throw new Error('This Pal provider is not configured. Set it up in Namzu first.')
		// Read from the Pal on every call, never cached in `selections`: the Pal's model is the
		// source of truth for its conversation until the person picks another one by hand there.
		return {
			...(base ?? { version: 3, subagents: { active: [] } }),
			providers: [{ id: entry.id, model: profile.model }],
		} satisfies Preferences
	}

	const ensureSession = async (
		sessionId: string,
		requestedCwd: string,
		signal: AbortSignal,
	): Promise<AcpRuntimeRecord> => {
		signal.throwIfAborted()
		if (closed)
			throw engineFailure(
				'connection-closed',
				'Namzu lost its connection to this conversation. Try again, or restart Namzu if it keeps happening.',
			)

		// This is the first project-aware operation. Session creation and the
		// protocol handshake remain credential-free and do not read the target.
		const trust = deps.decideTrust({ cwd: requestedCwd, trustFlag: false })
		if (!trust.allowed)
			throw engineFailure(
				'folder-not-trusted',
				trust.message ?? 'Trust this folder first, then send again.',
			)
		const cwd = trust.cwd
		const palBinding = await deps.palBinding?.(cwd, sessionId)
		if (palBinding?.pal.paused) throw new Error('This Pal is paused.')
		if (selecting.has(sessionId)) throw new Error('Wait for the model change to finish.')
		// A cold undo read or write in flight owns the directory; its own store is
		// released before a live one is opened over it.
		await undoTails.get(sessionId)
		if (undoing.has(sessionId)) throw new Error('Wait for the undo to finish.')
		const existing = records.get(sessionId)
		if (existing) {
			if (existing.cwd !== cwd) {
				throw engineFailure(
					'conversation-in-other-folder',
					'This conversation is already open in another folder. Open it again from the sidebar.',
				)
			}
			return existing
		}
		if (constructing.has(sessionId)) {
			throw engineFailure(
				'conversation-opening',
				'This conversation is still opening. Wait a moment, then try again.',
			)
		}
		constructing.set(sessionId, cwd)
		const carriedRetry = retryCarry.get(sessionId)

		const construction = (async (): Promise<AcpRuntimeRecord> => {
			let candidate: AcpLiveSession | undefined
			let conversationState: Awaited<ReturnType<typeof openSessions>> | undefined
			const closeCandidate = async () => {
				const owned = candidate
				candidate = undefined
				try {
					if (owned) await owned.close()
				} finally {
					if (conversationState) closeSessions(conversationState)
					conversationState = undefined
				}
			}
			try {
				const projectCtx = (deps.refreshProjectContext ?? deps.resolveProjectContext)(
					bootstrapCtx,
					cwd,
				)
				warnLegacyMcpPermissionNames(projectCtx.config.permissions)
				const permissions = compilePermissionLayers(
					permissionLayersOf(projectCtx.config),
					projectCtx.config.permissionChecks,
				)
				if (permissions.diagnostics.length > 0) {
					throw new Error(
						permissions.diagnostics
							.map((diagnostic) => {
								const where = diagnostic.pattern
									? `permissions.${diagnostic.tool}."${diagnostic.pattern}"`
									: `permissions.${diagnostic.tool}`
								return `${where}: ${diagnostic.message}`
							})
							.join('\n'),
					)
				}

				const probe = await sharedProbe()
				signal.throwIfAborted()
				if (closed)
					throw engineFailure(
						'connection-closed',
						'Namzu lost its connection while this conversation was opening. Try again.',
					)
				const prefs = await preferencesFor(sessionId, probe, cwd)
				const primary = prefs?.providers[0]
				if (!prefs || !primary) {
					throw engineFailure(
						'no-provider',
						'Namzu has no AI service set up on this computer yet. Add a key or sign in to one in Settings, then send again.',
					)
				}

				const target = await deps.resolveSession(sessionId)
				signal.throwIfAborted()
				if (closed)
					throw engineFailure(
						'connection-closed',
						'Namzu lost its connection while this conversation was opening. Try again.',
					)
				conversationState = await deps.openSessions?.(cwd)
				const palRuntime = palBinding ? await deps.palRuntime?.() : undefined
				if (palBinding && !palRuntime) throw new Error('This Pal runtime is unavailable.')
				signal.throwIfAborted()
				const routeOwner: { current?: AcpRuntimeRecord } = {}
				const palEnvironment =
					palBinding && palRuntime
						? palSessionEnvironment(palRuntime, palBinding.definition, sessionId)
						: undefined
				// The browser tools, for the desktop only and never beside a Pal's own
				// computer: the same host, profile and site rules the terminal uses,
				// started on the first browser call and closed with the session.
				const browserConfig = projectCtx.config.browser
				const browserSites =
					runtimeOptions.computerUse === true && !palEnvironment && browserConfig?.enabled !== false
						? compileBrowserSites(browserConfig?.sites)
						: undefined
				// The computer tools are off until the user's own settings turn them on.
				const computerOn =
					runtimeOptions.computerUse === true &&
					!palEnvironment &&
					computerUseEnabled(projectCtx.config)
				candidate = await deps.createSession(prefs, probe.detected, {
					...(palEnvironment ? { palEnvironment } : {}),
					// The host PC, for the desktop only. A Pal conversation has its own
					// computer behind the same tool name, so it never gets both.
					...(computerOn
						? {
								enableComputerUse: true,
								...(runtimeOptions.observeComputer
									? {
											onComputerObservation: (seen: ComputerUseObservation) =>
												runtimeOptions.observeComputer?.(sessionId, seen),
										}
									: {}),
							}
						: {}),
					// The desktop shows what a turn writes in its Browser and Files panes; the model is told so.
					...(runtimeOptions.announce && !palEnvironment ? { desktop: true } : {}),
					// The model may read the safe settings and change one when the person says yes on
					// the card; the desktop's own preferences join when the app said where they are.
					...(runtimeOptions.announce &&
					!palEnvironment &&
					projectCtx.config.agentSettings !== false
						? { settingsTools: settingsContext(cwd) }
						: {}),
					cwd,
					sessionId: target.sessionId,
					...(conversationState
						? {
								conversationSessions: conversationState,
								scope: {
									sessionId: target.sessionId,
									projectId: conversationState.projectId,
									topicId: conversationState.topicId,
									tenantId: conversationState.tenantId,
								},
							}
						: {}),
					...(target.origin ? { origin: target.origin } : {}),
					rules: browserSites
						? withBrowserSiteRules(permissions.rules, browserSites.rules)
						: permissions.rules,
					...(browserSites
						? {
								browser: {
									...(browserConfig?.defaultProfile
										? { profile: browserConfig.defaultProfile }
										: {}),
									...(browserConfig?.engine ? { engine: browserConfig.engine } : {}),
									...(browserConfig?.headless ? { headless: browserConfig.headless } : {}),
									sites: browserSites.sites,
									...(browserConfig?.keepOpen ? { keepOpen: true } : {}),
									...(browserConfig?.signInDetection
										? { signInDetection: browserConfig.signInDetection }
										: {}),
									...(conversationState ? { home: conversationState.root } : {}),
								},
							}
						: {}),
					// Every key the configuration sets for a session, through the one function
					// `exec` reads them with: this host cannot miss one the terminal honours.
					...sessionOptionsFromConfig(projectCtx.config, { cwd }),
					// The desktop application is watched live; a Pal and any other client are not.
					...(() => {
						const nudge = palEnvironment
							? undefined
							: resolveProgressNudge(projectCtx.config.progressNudge, {
									watched: runtimeOptions.computerUse === true,
								})
						return nudge ? { progressNudge: nudge } : {}
					})(),
					// Routed turns only where Auto is what runs: never for a Pal, and not after the
					// person hand-picked a model for this conversation.
					...(projectCtx.config.routing &&
					autoIsActive(sessionId, projectCtx.config, palBinding != null)
						? { routing: projectCtx.config.routing }
						: {}),
					onSessionEvent: (event: SessionEvent) => routeOwner.current?.route?.(event),
				})
				if (signal.aborted || closed) {
					await closeCandidate()
					signal.throwIfAborted()
					throw engineFailure(
						'connection-closed',
						'Namzu lost its connection while this conversation was opening. Try again.',
					)
				}
				if (!candidate.hasProvider) {
					const hint = candidate.errorHint ?? 'Namzu isn’t ready yet. Try again in a moment.'
					await closeCandidate()
					throw new Error(hint)
				}
				if (candidate.mcpFailed.length > 0) {
					mcpFailures.set(
						mcpKey(cwd),
						candidate.mcpFailed.map(({ name, reason }) => ({
							name,
							reason,
							config: JSON.stringify(projectCtx.config.mcpServers?.[name] ?? null),
						})),
					)
					const failure = candidate.mcpFailed
						.map((entry) => `The connected tool “${entry.name}” isn’t available: ${entry.reason}`)
						.join('\n')
					await closeCandidate()
					throw new Error(failure)
				}
				mcpFailures.delete(mcpKey(cwd))
				for (const [name, enabled] of pluginOverrides.get(sessionId) ?? []) {
					if (!candidate.plugins?.list().some((plugin) => plugin.name === name)) {
						throw new Error(
							'A previously selected plugin is no longer available in this conversation.',
						)
					}
					await candidate.plugins.setEnabled(name, enabled)
					signal.throwIfAborted()
					if (closed) throw new Error('The connection closed while restoring plugin choices.')
				}

				const record: AcpRuntimeRecord = {
					cwd,
					session: candidate,
					ownedPal: !!palBinding,
					...(palBinding
						? { palId: palBinding.pal.id, readyComputer: palEnvironment?.readyComputer }
						: {}),
					provider: primary.id,
					...(projectCtx.config.skills ? { skillsConfig: projectCtx.config.skills } : {}),
					...(projectCtx.config.permissionSettings
						? { permissionSettings: projectCtx.config.permissionSettings }
						: {}),
					turnOptions: turnOptionsFromConfig(projectCtx.config),
					...(hypermodeRefusal(projectCtx.config) ? { workflowsOff: true as const } : {}),
					staleResults: new IdleCompactor(staleResultsDeps(sessionId)),
					model:
						primary.model ??
						probe.detected.find(({ entry }) => entry.id === primary.id)?.entry.defaultModel ??
						'',
					...(carriedRetry ? { retrySettings: carriedRetry } : {}),
					conversations: conversationState,
					route: undefined,
				}
				routeOwner.current = record
				if (records.has(sessionId)) {
					await closeCandidate()
					throw new Error(`ACP session "${sessionId}" was published by another operation.`)
				}
				records.set(sessionId, record)
				candidate = undefined
				conversationState = undefined
				return record
			} finally {
				constructing.delete(sessionId)
				await closeCandidate()
			}
		})()

		// Session startup can include provider, MCP and sandbox work that does
		// not itself settle when the wire prompt is cancelled. Release the ACP
		// turn immediately, but keep this construction observed and reserved;
		// its own fences close any candidate that eventually arrives.
		return waitForOperation(construction, signal)
	}

	const gateway: AcpAgentGateway = {
		load: async (sessionId, requestedCwd) => {
			if (!requestedCwd) throw new Error('A project is required to load a conversation.')
			const root = resolveNamzuHome()
			const trust = deps.decideTrust({ cwd: requestedCwd, trustFlag: false })
			if (!trust.allowed) throw new Error(trust.message)
			const target = await deps.resolveSession(sessionId)
			const reading = await openReadScope(trust.cwd, root)
			try {
				assertReadTrust(trust.cwd, reading.state)
				await deps.palBinding?.(trust.cwd, target.sessionId, reading.state)
				return await loadResumableConversation(reading.state, target.sessionId)
			} finally {
				reading.close()
			}
		},
		prompt: async ({
			sessionId,
			prompt,
			attachments,
			options,
			pasted,
			cwd,
			onEvent,
			signal,
			ask,
			history,
		}) => {
			let record: AcpRuntimeRecord
			try {
				record = await ensureSession(sessionId, cwd, signal)
			} catch (error) {
				if (signal.aborted) return { stopReason: 'cancelled' }
				throw error
			}
			if (
				record.session.imageAttachmentsSupported === false &&
				attachments?.some((file) => file.type !== 'document')
			)
				throw new Error(
					'This model cannot receive images. Choose a model that supports images before sending this attachment.',
				)
			if (
				record.session.documentAttachmentsSupported === false &&
				attachments?.some((file) => file.type === 'document')
			)
				throw new Error(
					'This model cannot receive documents. Choose a model that supports documents before sending this attachment.',
				)
			// Wraps `onEvent`, not aliases it: `toAcpSessionUpdate` reads
			// `presenter` synchronously while building the update this call
			// produces, so `activeRecord` is `record` for exactly that
			// synchronous span and restored (not just cleared) afterward — a
			// concurrent session's own routed event, firing between two of
			// this session's, sets and restores the SAME variable around its
			// own span without corrupting this one. `routedEvent`, not
			// `onEvent`, is what the `finally` below compares against, since
			// `record.route` never holds `onEvent` itself anymore.
			let liveInbox: LivePromptInbox | undefined
			let liveTurn: { mode: PermissionMode } | undefined
			// A conversation's first message is named once, beside its first turn.
			if (history.length === 0 && prompt.trim().length > 0) titleFeed?.expect(sessionId, prompt)
			const routedEvent = (event: SessionEvent): void => {
				if (
					event.type === 'turn_completed' ||
					event.type === 'turn_failed' ||
					event.type === 'turn_paused'
				)
					liveInbox?.close()
				const outer = activeRecord
				activeRecord = record
				try {
					onEvent(event)
				} finally {
					activeRecord = outer
				}
				try {
					contextTracker.observe(sessionId, event)
					runtimeOptions.observeEvent?.(sessionId, event)
					titleFeed?.observe(sessionId, event)
				} catch {
					/* An observer is a view of the turn, never part of it. */
				}
			}
			record.route = routedEvent
			try {
				let stopReason: string | undefined
				let failureMessage: string | undefined
				let settledHistory: readonly Message[] | undefined
				const onPermission = async (request: {
					toolCalls: readonly (MustAskCall & {
						id: string
						name: string
						input: unknown
						isDestructive: boolean
					})[]
					screenConsent?: true
				}) => {
					const outcome = await ask({
						sessionId,
						toolCalls: await withPreviews(request.toolCalls, [record.cwd], {
							askEveryCall: request.screenConsent === true,
							computer: (call) =>
								record.session.describeComputerUseCall?.(call.name, call.input) ??
								Promise.resolve(undefined),
							settingChange: (call) =>
								call.name === SET_SETTING_TOOL
									? describeAgentChange(settingsContext(record.cwd), call.input)
									: undefined,
						}),
					})
					switch (outcome.kind) {
						case 'approve':
							return { kind: 'approve' as const }
						case 'approve_all':
							return { kind: 'approve-all' as const }
						case 'reject':
							return {
								kind: 'reject' as const,
								...(outcome.feedback ? { feedback: outcome.feedback } : {}),
								...(outcome.declined ? { declined: outcome.declined } : {}),
							}
					}
				}
				const typed = createUserMessage(prompt, attachments)
				// The host checked the ranges against `prompt`; each gets its own nonce, kept
				// with the message so every request and a resume frame it the same way.
				const pastedMessage: Message = pasted?.length
					? {
							...typed,
							pasted: pasted.map((range) => ({ ...range, nonce: newPasteNonce(prompt) })),
						}
					: typed
				// When the person sent it, and how long after their last message.
				const timeNote = messageTimeNote({
					now: typed.timestamp ?? Date.now(),
					previous: previousSentAt(history as Message[]),
				})
				const userMessage: Message = timeNote ? { ...pastedMessage, timeNote } : pastedMessage
				const messages = [...(history as Message[]), userMessage]
				const settings = validateComposerSendSettings(
					options,
					record.session,
					record.ownedPal ? 'auto' : 'prompt',
				)
				assertModeAllowed(record, settings.permissionMode)
				// A classifier that stops being trusted drops the rest of this turn to
				// asking, which the person sees as the approval prompts they now get.
				const turn = { mode: settings.permissionMode }
				liveTurn = turn
				record.liveMode = turn
				if (!record.ownedPal) {
					liveInputs.get(sessionId)?.close()
					liveInbox = new LivePromptInbox(
						record,
						record.conversations?.root ?? resolveNamzuHome(),
						() =>
							!closed &&
							records.get(sessionId) === record &&
							record.route === routedEvent &&
							!signal.aborted &&
							!selecting.has(sessionId),
					)
					liveInputs.set(sessionId, liveInbox)
				}
				// Snapshot before admission; a later/current lease is never historical proof.
				const computer = readyComputerPin(record)
				const original = {
					turnId: '',
					settings,
					...(computer ? { computer } : {}),
				}
				const inputInbox = liveInbox
				// ACP starts no turn of its own, so what a monitor said while nobody
				// was prompting waits here and rides with this prompt; what the kernel
				// delivered during an earlier turn was acknowledged and is not here.
				const monitorSnapshot = record.session.monitors?.peek() ?? { ids: [] }
				// A turn the host before this one left with nobody running it is closed, not waited for;
				// the same rule the status applies, so a message and the status never disagree.
				if (record.conversations)
					await settleTurnOfGoneHost(record.conversations, sessionId).catch(() => false)
				const undoNote = undoNotes.get(sessionId)?.join('\n\n')
				undoNotes.delete(sessionId)
				// A conversation's name being saved holds its log for a moment; the turn goes after it.
				await titleFeed?.saved(sessionId)
				// A conversation picked up after its prompt cache lapsed is re-read at full
				// price anyway: old tool results can go now. Read before this turn's calls.
				const staleResults = record.session.clearStaleResultsAfterIdle
					? record.staleResults.staleResultsRequest()
					: undefined
				for await (const event of record.session.send(messages, {
					...settings,
					// The configuration's per-turn choices: hypermode, refusal fallback.
					...record.turnOptions,
					// The composer's own choice for this conversation wins over the saved one, and is
					// never sent while dynamic workflows are off.
					...(record.workflowsOff
						? { hypermode: undefined }
						: settings.hypermode !== undefined
							? { hypermode: settings.hypermode }
							: {}),
					...(staleResults ? { clearStaleToolResults: staleResults } : {}),
					// The words the person sent: a target such as +500k is read from these only.
					typedInput: prompt,
					currentPermissionMode: () => turn.mode,
					onAutoModeLimit: () => {
						turn.mode = 'prompt'
					},
					...(undoNote ? { systemNote: undoNote } : {}),
					...(computer
						? { assertExecutionAllowed: () => assertRetryComputer(record, original) }
						: {}),
					signal,
					onPermission,
					// The one question a Desktop conversation can raise itself: the screen is
					// needed for a moment. It reaches the person as a card, never as a standing yes.
					...(runtimeOptions.computerUse === true
						? { onQuestion: questionsOverPermission(sessionId, ask, signal) }
						: {}),
					...(monitorSnapshot.text ? { hostContext: () => [monitorSnapshot.text as string] } : {}),
					...(inputInbox
						? {
								inboundMessages: () => {
									assertLiveOwner(sessionId, inputInbox)
									return inputInbox.drain()
								},
								waitForInbound: inputInbox.wait,
							}
						: {}),
					onConversationMessages: (messages) => {
						settledHistory = [...messages]
					},
				})) {
					if (event.kind === 'usage') record.staleResults.recordCall(event.cache)
					if (event.kind === 'done' || event.kind === 'error' || event.kind === 'paused')
						liveInbox?.close()
					if (event.kind === 'done') stopReason = event.stopReason
					else if (event.kind === 'error' || event.kind === 'paused') {
						stopReason = signal.aborted ? 'cancelled' : 'error'
						if (event.kind === 'error' && !signal.aborted) failureMessage = event.message
						if (event.kind === 'paused')
							record.retrySettings = { ...original, turnId: event.turnId }
					}
				}
				if (signal.aborted) stopReason = 'cancelled'
				if (stopReason === 'end_turn' && monitorSnapshot.ids.length > 0)
					record.session.monitors?.acknowledge(monitorSnapshot.ids)
				if (stopReason === 'error' && settledHistory === undefined && failureMessage)
					throw new Error(failureMessage)
				return {
					...(stopReason === undefined ? {} : { stopReason }),
					...(settledHistory === undefined ? {} : { history: settledHistory }),
				}
			} finally {
				liveInbox?.close()
				if (liveTurn && record.liveMode === liveTurn) record.liveMode = undefined
				if (record.route === routedEvent) record.route = undefined
				void titleFeed?.flush(sessionId)
			}
		},
		retry: async ({ sessionId, turnId, checkpointId, options, cwd, signal, onEvent, ask }) => {
			const record = await ensureSession(sessionId, cwd, signal)
			if (!record.conversations || !record.session.resumePaused)
				throw new Error(
					'Namzu can’t repeat this reply in this conversation. Continue without it, or send your message again.',
				)
			if (record.route) throw new Error('This conversation already has active work.')
			const target = await deps.resolveSession(sessionId)
			const status = await (deps.readRetryStatus ?? readProviderRetryStatus)(
				record.conversations,
				target.sessionId,
			)
			if (status.retry?.turnId !== turnId || status.retry.checkpointId !== checkpointId)
				throw new Error(
					status.notice ??
						'This paused reply has changed. Reopen the conversation to see its latest state.',
				)
			const original = record.retrySettings?.turnId === turnId ? record.retrySettings : undefined
			assertRetryComputer(record, original)
			const previous = original?.settings
			if (!previous && options?.permissionMode === undefined)
				throw engineFailure(
					'permission-mode-needed',
					'Namzu can’t restore the approval settings for this reply. Choose how much Namzu may do, then try again.',
				)
			const settings = validateComposerSendSettings(
				{ ...previous, ...options },
				record.session,
				'prompt',
			)
			assertModeAllowed(record, settings.permissionMode)
			const facts = await readConversationFacts(record.conversations, target.sessionId)
			const started = facts?.startedTurn(turnId)
			const pause = facts?.latestPause(turnId)
			if (!started?.model || !pause?.providerError)
				throw new Error(
					'Namzu can’t confirm which AI service and model this reply used, so it can’t try it again here.',
				)
			if (!record.model)
				throw new Error(
					'Namzu can’t confirm which model this reply used, so it can’t try it again here.',
				)
			const routedEvent = (event: SessionEvent): void => {
				const outer = activeRecord
				activeRecord = record
				try {
					onEvent(event)
				} finally {
					activeRecord = outer
				}
			}
			record.route = routedEvent
			retriedOn.set(turnId, { provider: record.provider, model: record.model })
			try {
				let stopReason: string | undefined
				let failureMessage: string | undefined
				const undoNote = undoNotes.get(sessionId)?.join('\n\n')
				undoNotes.delete(sessionId)
				for await (const event of record.session.resumePaused({
					turnId,
					checkpointId,
					...(undoNote ? { systemNote: undoNote } : {}),
					signal,
					permissionMode: settings.permissionMode,
					...(record.ownedPal
						? { assertExecutionAllowed: () => assertRetryComputer(record, original) }
						: {}),
					model: {
						provider: record.provider,
						// The model selected now, which is the failed one unless the person changed it.
						model: record.model,
						...(settings.effort ? { effort: settings.effort } : {}),
					},
					onPermission: async (request) => {
						const outcome = await ask({
							sessionId,
							toolCalls: await withPreviews(request.toolCalls, [record.cwd], {
								askEveryCall: request.screenConsent === true,
								computer: (call) =>
									record.session.describeComputerUseCall?.(call.name, call.input) ??
									Promise.resolve(undefined),
								settingChange: (call) =>
									call.name === SET_SETTING_TOOL
										? describeAgentChange(settingsContext(record.cwd), call.input)
										: undefined,
							}),
						})
						if (outcome.kind === 'approve_all') return { kind: 'approve-all' }
						if (outcome.kind === 'approve') return { kind: 'approve' }
						return {
							kind: 'reject',
							...(outcome.feedback ? { feedback: outcome.feedback } : {}),
							...(outcome.declined ? { declined: outcome.declined } : {}),
						}
					},
				})) {
					if (event.kind === 'done') stopReason = event.stopReason
					if (event.kind === 'paused') {
						stopReason = 'paused'
						record.retrySettings = { ...original, turnId: event.turnId, settings }
					}
					if (event.kind === 'error') {
						stopReason = 'error'
						failureMessage = event.message
					}
				}
				if (signal.aborted) stopReason = 'cancelled'
				if (failureMessage && !signal.aborted) throw new Error(failureMessage)
				return {
					...(stopReason ? { stopReason } : {}),
					history: await loadConversation(record.conversations, target.sessionId),
				}
			} finally {
				if (record.route === routedEvent) record.route = undefined
			}
		},
	}

	/**
	 * The same admission `providerRetryStatus` gives a read: this connection is
	 * open, the folder is trusted at the scope's own home, and the scope is the
	 * one this conversation's runtime (if any) was opened under.
	 */
	const admitUndo = async (
		sessionId: string,
		requestedCwd: string,
		authenticated: CliSessionScope,
	) => {
		if (closed) throw new Error('The connection is closed.')
		const trust = deps.decideTrust({
			cwd: requestedCwd,
			trustFlag: false,
			trusted: (dir: string) => isTrustedAtStateRoot(dir, authenticated.root),
		})
		if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
		const record = records.get(sessionId)
		if (record && record.cwd !== trust.cwd)
			throw new Error('This conversation belongs to another project.')
		if (!isTrustedAtStateRoot(trust.cwd, authenticated.root))
			throw new Error('Trust this folder first.')
		const cwd = canonicalProjectPath(trust.cwd)
		const projectRoot = palAtWorkspace(cwd, authenticated.root) ? cwd : cliProjectRoot(cwd)
		if (
			authenticated.projectRoot !== projectRoot ||
			(record?.conversations &&
				(authenticated.root !== record.conversations.root ||
					authenticated.projectId !== record.conversations.projectId ||
					authenticated.tenantId !== record.conversations.tenantId))
		)
			throw new Error(
				'This conversation belongs to a different project or to another Namzu data folder.',
			)
		const target = await deps.resolveSession(sessionId)
		const binding = await deps.palBinding?.(trust.cwd, target.sessionId, authenticated)
		return { record, cwd: trust.cwd, sessionId: target.sessionId, binding }
	}
	/**
	 * A live conversation's own store when it has one (two stores over one
	 * directory would each hold a stale picture of the other's writes), else a
	 * cold one built from the directory alone.
	 */
	const withUndoStore = async <T>(
		admitted: Awaited<ReturnType<typeof admitUndo>>,
		scope: CliSessionScope,
		run: (store: FileCheckpointStore) => Promise<T>,
	): Promise<T> => {
		const live = admitted.record?.session.checkpoints
		if (live) {
			await live.open()
			return run(live)
		}
		const id = admitted.sessionId
		const prior = undoTails.get(id) ?? Promise.resolve()
		const turn = prior.then(async () => {
			// A live session opened since: its store owns the directory now.
			if (records.has(id) || constructing.has(id))
				throw new Error('Wait for the conversation to finish opening, then try again.')
			const cold = new FileCheckpointStore(
				scope.paths.fileHistory({ sessionId: asSessionId(id) }),
				admitted.cwd,
			)
			try {
				await cold.open()
				return await run(cold)
			} finally {
				await cold.release()
			}
		})
		const tail = turn.then(
			() => undefined,
			() => undefined,
		)
		undoTails.set(id, tail)
		void tail.then(() => {
			if (undoTails.get(id) === tail) undoTails.delete(id)
		})
		return turn
	}
	const turnUndo: CliTurnUndo = {
		status: async (sessionId, requestedCwd, scope, turnIds) => {
			const admitted = await admitUndo(sessionId, requestedCwd, scope)
			return withUndoStore(admitted, scope, async (store) => ({
				turns: await store.undoStatus(turnIds),
			}))
		},
		preview: async (sessionId, requestedCwd, scope, turnId, options) => {
			const admitted = await admitUndo(sessionId, requestedCwd, scope)
			return withUndoStore(admitted, scope, (store) =>
				store.previewUndo(turnId, { alsoUndoLater: options?.alsoUndoLater === true }),
			)
		},
		undo: async (sessionId, requestedCwd, scope, request) => {
			const admitted = await admitUndo(sessionId, requestedCwd, scope)
			if (undoing.has(sessionId)) throw new Error('Wait for the undo to finish.')
			// Claimed before any further await, so no prompt can start under the undo.
			undoing.add(sessionId)
			try {
				// Looked up again: a prompt may have opened the conversation since admission.
				const current = { ...admitted, record: records.get(sessionId) }
				const { record, binding } = current
				if (binding?.pal.paused) throw new Error('This Pal is paused.')
				if (record?.route || selecting.has(sessionId) || constructing.has(sessionId))
					throw new Error('Wait for the current reply to finish before undoing.')
				if (record?.session.jobs?.().some((job) => job.status === 'running'))
					throw new Error('A background command is still running. Stop it before undoing.')
				if (binding && (await deps.palRuntime?.())?.busy(binding.pal.id))
					throw new Error('Wait for this Pal’s current work to settle before undoing.')
				return await withUndoStore(current, scope, async (store): Promise<TurnUndoResult> => {
					const outcome = await store.undo(request.turnId, {
						planToken: request.planToken,
						...(request.resolutions ? { resolutions: request.resolutions } : {}),
						...(request.alsoUndoLater ? { alsoUndoLater: true } : {}),
						by: 'desktop',
					})
					if (outcome.kind === 'plan-changed')
						return {
							turnId: request.turnId,
							status: 'plan-changed',
							files: {},
							replan: outcome.plan,
						}
					if (outcome.changed.length > 0) {
						// The model's picture of these files is wrong now: refuse its next
						// edit until it reads them again, and tell it why in plain words.
						await record?.session.markFilesChanged?.(outcome.changed)
						const shown = outcome.changed
							.slice(0, 20)
							.map((path) => relative(current.cwd, path) || path)
						const more = outcome.changed.length - shown.length
						// Two undos before the next prompt: the model hears about both.
						undoNotes.set(sessionId, [
							...(undoNotes.get(sessionId) ?? []),
							[
								'The operator undid the file changes of an earlier reply. These files were put back or removed outside your tools, so what you remember of them may be stale. Read a file again before you edit it:',
								...shown.map((path) => `- ${path}`),
								...(more > 0 ? [`- and ${more} more`] : []),
							].join('\n'),
						])
					}
					return {
						turnId: outcome.turnId,
						status: outcome.status,
						files: outcome.files,
						later: outcome.later,
						copies: outcome.copies,
					}
				})
			} finally {
				undoing.delete(sessionId)
			}
		},
	}

	return {
		gateway,
		presenter,
		turnUndo,
		suggestCommitMessage: async (sessionId, request, signal) => {
			const side = records.get(sessionId)?.session.sideModel
			if (!side) return undefined
			return side.ask({
				sessionId: sessionId as SessionId,
				turnId: generateTurnId(),
				instruction: COMMIT_MESSAGE_INSTRUCTION,
				body: commitMessageBody(request),
				maxTokens: 300,
				signal,
				timing: 'beside-turn',
			})
		},
		setPermissionMode: async (sessionId, mode) => {
			if (closed) throw new Error('The connection is closed.')
			const record = records.get(sessionId)
			if (!record) return { mode, applied: 'next-message' }
			assertModeAllowed(record, mode)
			const turn = record.liveMode
			if (!turn) return { mode, applied: 'next-message' }
			// The turn reads its mode at every decision; the log and the model hear of the change
			// before a call is decided under it.
			turn.mode = mode
			await record.session.setPermissionMode?.(mode)
			return { mode, applied: 'now' }
		},
		liveInputStatus: async (sessionId, scopeId, scope) => {
			if (closed) throw new Error('The connection is closed.')
			const inbox = liveInputs.get(sessionId)
			if (!inbox) {
				if (scopeId !== undefined) throw new Error('This live prompt scope is no longer available.')
				return { available: false, inputs: [] }
			}
			assertLiveOwner(sessionId, inbox, scope)
			if (scopeId !== undefined && scopeId !== inbox.scopeId)
				throw new Error('This live prompt scope is no longer available.')
			return inbox.status()
		},
		liveInput: async (sessionId, input, scope) => {
			const inbox = liveInputs.get(sessionId)
			if (!inbox) throw new Error('This conversation has no active live prompt.')
			assertLiveOwner(sessionId, inbox, scope)
			return inbox.accept(input)
		},
		providerRetryStatus: async (sessionId, requestedCwd, authenticatedScope) => {
			if (closed) throw new Error('The connection is closed.')
			const root = authenticatedScope?.root ?? resolveNamzuHome()
			const trust = deps.decideTrust({
				cwd: requestedCwd,
				trustFlag: false,
				...(authenticatedScope
					? { trusted: (dir: string) => isTrustedAtStateRoot(dir, authenticatedScope.root) }
					: {}),
			})
			if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
			const record = records.get(sessionId)
			if (record && record.cwd !== trust.cwd)
				throw new Error('This conversation belongs to another project.')
			if (authenticatedScope) {
				if (!isTrustedAtStateRoot(trust.cwd, authenticatedScope.root))
					throw new Error('Trust this folder first.')
				const cwd = canonicalProjectPath(trust.cwd)
				const projectRoot = palAtWorkspace(cwd, authenticatedScope.root) ? cwd : cliProjectRoot(cwd)
				if (
					authenticatedScope.projectRoot !== projectRoot ||
					(record?.conversations &&
						(authenticatedScope.root !== record.conversations.root ||
							authenticatedScope.projectId !== record.conversations.projectId ||
							authenticatedScope.tenantId !== record.conversations.tenantId))
				)
					throw new Error(
						'This conversation belongs to a different project or to another Namzu data folder.',
					)
			}
			const target = await deps.resolveSession(sessionId)
			const reading =
				authenticatedScope || record?.conversations
					? {
							state: authenticatedScope ?? (record?.conversations as CliSessionScope),
							close: () => {},
						}
					: await openReadScope(trust.cwd, root)
			const state = reading.state
			try {
				assertReadTrust(trust.cwd, state)
				const binding = await deps.palBinding?.(trust.cwd, target.sessionId, state)
				// This host is the one that is opening the conversation now. A turn the host before it left
				// with nobody running it is over; the status below must not tell the person to wait for it.
				await settleTurnOfGoneHost(
					state,
					target.sessionId,
					record?.session.abandonTurn
						? async (turnId, reason) =>
								record.session.abandonTurn?.(asTurnId(turnId), reason, { withdrawMessages: false })
						: undefined,
				)
				const status = await (deps.readRetryStatus ?? readProviderRetryStatus)(
					state,
					target.sessionId,
				)
				if (!status.retry) return status
				const blocked = (notice: string): ProviderRetryStatus => ({
					notice,
					...(status.closable ? { closable: true as const } : {}),
				})
				if (binding) {
					if (!record) return blocked(MISSING_RETRY_COMPUTER)
					try {
						assertRetryComputer(
							record,
							record.retrySettings?.turnId === status.retry.turnId
								? record.retrySettings
								: undefined,
						)
					} catch (error) {
						return blocked(error instanceof Error ? error.message : MISSING_RETRY_COMPUTER)
					}
				}
				if (binding && (await deps.palRuntime?.())?.busy(binding.pal.id))
					return blocked(
						'Wait for this Pal’s current work to settle before retrying another conversation.',
					)
				if ((record?.retrySettings ?? retryCarry.get(sessionId))?.turnId !== status.retry.turnId)
					return blocked(
						'Namzu can’t restore the approval settings for this reply. Choose how much Namzu may do, then try again.',
					)
				const facts = await readConversationFacts(state, target.sessionId)
				const pause = status.retry?.turnId ? facts?.latestPause(status.retry.turnId) : undefined
				if (!pause?.providerError)
					return blocked(
						'Namzu can’t confirm which AI service this reply used, so it can’t try it again here.',
					)
				// A turn already retried stopped again on the model it was retried on.
				const lastRun = retriedOn.get(status.retry.turnId)
				return lastRun && !status.retry.original
					? { ...status, retry: { ...status.retry, original: lastRun } }
					: status
			} finally {
				reading.close()
			}
		},
		abandonPausedTurn: async (sessionId, requestedCwd, turnId, options) => {
			const record = await ensureSession(sessionId, requestedCwd, new AbortController().signal)
			// Closing a reply is one append to the conversation's own log; it needs no provider and no
			// live-session method, so a session that does not carry one is closed through the log.
			if (!record.conversations)
				throw new Error('Namzu can’t read this conversation right now. Open it again.')
			if (record.route) throw new Error('This conversation already has active work.')
			const target = await deps.resolveSession(sessionId)
			const facts = await readConversationFacts(record.conversations, target.sessionId)
			const active = facts?.activeTurn
			if (!active?.paused || (turnId !== undefined && active.turnId !== turnId))
				throw new Error('This conversation has no paused turn to close. Open it again.')
			const pausedTurn = active.turnId
			const pause = facts?.latestPause(pausedTurn)
			if (!pause || pause.handoff || !pause.providerError)
				throw new Error('Only a turn that stopped on a provider error can be closed this way.')
			if (facts?.pendingDecisions(pausedTurn).size)
				throw new Error('This turn is waiting for a decision; answer it first.')
			const reason = 'The person continued without the reply that stopped on a provider error.'
			// Unless the person goes on with a different message, theirs goes back to the message
			// box: the closed turn must not also reach the provider with it when they send it again.
			const withdrawMessages = options?.withdrawMessages !== false
			if (record.session.abandonTurn) {
				await record.session.abandonTurn(asTurnId(pausedTurn), reason, { withdrawMessages })
			} else {
				await abandonTurn(target.sessionId, asTurnId(pausedTurn), reason, {
					log: DiskSessionLog.at(record.conversations.paths, { sessionId: target.sessionId }),
					index: record.conversations.index,
					...(withdrawMessages ? { withdrawMessages: true } : {}),
				})
			}
			return { closed: true as const }
		},
		modelSettings: async (provider, model, sessionId) => {
			if (closed) throw new Error('The connection is closed.')
			if (sessionId !== undefined && !isEntityId(sessionId, 'session'))
				throw new Error('Invalid conversation id.')
			if (typeof model !== 'string' || !model.trim() || model.length > 400)
				throw new Error('Invalid model.')
			const probe = await sharedProbe()
			const detected = probe.detected.find(({ entry }) => entry.id === provider)
			if (!detected) throw new Error('This provider is not configured. Set it up in Namzu first.')
			const preferences = await preferencesFor(sessionId, probe)
			const record = sessionId ? records.get(sessionId) : undefined
			const workflowsOff = hypermodeRefusal(
				record
					? { workflow: record.workflowsOff ? { enabled: false } : undefined }
					: bootstrapCtx.config,
			)
				? { workflowsOff: true as const }
				: bootstrapCtx.config.hypermode === true
					? { hypermodeDefault: true as const }
					: {}
			// The running session answers only for the model it runs on, which can lag its Pal's.
			if (record && record.provider === provider && record.model === model) {
				return {
					effortLevels: record.session.reasoningEffortLevels,
					effortDefault: record.session.reasoningEffortDefault,
					...workflowsOff,
				}
			}
			const result = await (deps.describeReasoning ?? describeProviderReasoning)(
				{
					...(preferences ?? { version: 3, subagents: { active: [] } }),
					providers: [
						{
							id: detected.entry.id,
							model,
							...accountPin(preferences, detected.entry.id),
						},
						...(preferences?.providers.slice(1).filter((item) => item.id !== provider) ?? []),
					],
				},
				probe.detected,
				catalogueController.signal,
			)
			if (closed) throw new Error('The connection is closed.')
			return {
				effortLevels: result.effortLevels,
				effortDefault: result.effortDefault,
				...workflowsOff,
				...(result.notice
					? {
							notice: 'Reasoning choices could not be fully established for this model.',
						}
					: {}),
			}
		},
		plugins: async (requestedCwd, sessionId) => {
			if (closed) throw new Error('The connection is closed.')
			const trust = deps.decideTrust({ cwd: requestedCwd, trustFlag: false })
			if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
			if (sessionId && (await deps.palBinding?.(trust.cwd, sessionId)))
				return {
					plugins: [],
					live: false,
					canChange: false,
					notice: 'Host plugins are not inherited by Pals.',
				}
			const record = sessionId ? records.get(sessionId) : undefined
			if (record && record.cwd !== trust.cwd)
				throw new Error('This conversation belongs to another project.')
			const projectCtx = deps.resolveProjectContext(bootstrapCtx, trust.cwd)
			return (deps.readPlugins ?? readPluginInventory)({
				cwd: trust.cwd,
				config: projectCtx.config.plugins,
				runtime: record?.session.plugins,
				canChange: Boolean(
					record?.session.plugins &&
						!record.route &&
						!selecting.has(sessionId ?? '') &&
						!record.session.jobs?.().some((job) => job.status === 'running'),
				),
			})
		},
		mcpStatus: (requestedCwd) => {
			const connected = new Set<string>()
			const key = mcpKey(requestedCwd)
			for (const record of records.values()) {
				if (mcpKey(record.cwd) !== key) continue
				for (const server of record.session.mcpStatus?.().connected ?? [])
					connected.add(server.name)
			}
			return { connected: [...connected], failed: mcpFailures.get(key) ?? [] }
		},
		setPluginEnabled: async (sessionId, name, enabled, cwd) => {
			if (
				!isEntityId(sessionId, 'session') ||
				typeof name !== 'string' ||
				!name.trim() ||
				name.length > 400 ||
				typeof enabled !== 'boolean'
			)
				throw new Error('Invalid plugin choice.')
			const record = records.get(sessionId)
			if (cwd !== undefined) {
				const trust = deps.decideTrust({ cwd, trustFlag: false })
				if (!trust.allowed) throw new Error(trust.message ?? 'Trust this folder first.')
				if (record && record.cwd !== trust.cwd)
					throw new Error('This conversation belongs to another project.')
			}
			if (!record?.session.plugins)
				throw new Error('Start this conversation before changing loaded plugins.')
			if (
				closed ||
				constructing.has(sessionId) ||
				selecting.has(sessionId) ||
				record.route ||
				record.session.jobs?.().some((job) => job.status === 'running')
			)
				throw new Error('Stop this conversation’s active work before changing plugins.')
			if (!record.session.plugins.list().some((plugin) => plugin.name === name))
				throw new Error('This plugin is not loaded in this conversation.')
			selecting.add(sessionId)
			try {
				await record.session.plugins.setEnabled(name, enabled)
				if (closed) throw new Error('The connection is closed.')
				let overrides = pluginOverrides.get(sessionId)
				if (!overrides) {
					overrides = new Map()
					pluginOverrides.set(sessionId, overrides)
				}
				overrides.set(name, enabled)
				return await (deps.readPlugins ?? readPluginInventory)({
					cwd: record.cwd,
					runtime: record.session.plugins,
					canChange: true,
				})
			} finally {
				selecting.delete(sessionId)
			}
		},
		refreshProviders: async () => {
			probePromise = undefined
			catalogueRequests.clear()
			return { refreshed: true }
		},
		providerConnections: async () => ({ providers: await listProviderConnections() }),
		saveProviderKey: async (provider, apiKey) => {
			saveProviderKey(provider, apiKey)
			probePromise = undefined
			catalogueRequests.clear()
			return { saved: true }
		},
		removeProviderKey: async (provider) => {
			removeProviderKey(provider)
			probePromise = undefined
			catalogueRequests.clear()
			return { removed: true }
		},
		testProvider: async (provider) => {
			const id = typedKeyProvider(provider)
			const found = (await discoverProviders()).find(({ entry }) => entry.id === id)
			if (!found) return { status: 'missing' }
			const result = await (deps.verifyKey ?? verifyCredential)(id, found)
			return {
				status:
					result.kind === 'verified' ? 'ok' : result.kind === 'rejected' ? 'rejected' : 'unchecked',
				...(result.kind === 'unverifiable' && result.cause ? { cause: result.cause } : {}),
			}
		},
		providerStatus: async (sessionId) => {
			const probe = await sharedProbe()
			const choice = (await preferencesFor(sessionId, probe))?.providers[0]
			// Nothing saved and no conversation choice: the first entry is what Namzu found on its
			// own, best first (a sign-in, a key, a local server, then the free Zen models).
			const automatic =
				!probe.preferences && !(sessionId && selections.has(sessionId)) && !choice?.model
			const pal = sessionId
				? (await deps.palBinding?.(records.get(sessionId)?.cwd ?? process.cwd(), sessionId)) != null
				: false
			const auto = autoAvailable(bootstrapCtx.config, pal)
				? { active: autoIsActive(sessionId, bootstrapCtx.config, pal) }
				: undefined
			return {
				...(auto ? { auto } : {}),
				available: probe.detected.map((found) => ({
					id: found.entry.id,
					label: found.entry.label,
					defaultModel: found.entry.defaultModel,
					// Free models without a key: usable, but not something a person set up.
					...(isAnonymousZen(found) ? { anonymous: true } : {}),
					via: automaticKind(found),
				})),
				selected: choice
					? {
							id: choice.id,
							...(choice.model ? { model: choice.model } : {}),
							...(automatic ? { automatic: true } : {}),
						}
					: null,
			}
		},
		models: async (provider, sessionId) => {
			if (closed) throw new Error('The connection is closed.')
			if (sessionId !== undefined && !isEntityId(sessionId, 'session'))
				throw new Error('Invalid conversation id.')
			const probe = await sharedProbe()
			if (closed) throw new Error('The connection is closed.')
			const detected = probe.detected.find(({ entry }) => entry.id === provider)
			if (!detected) throw new Error('This provider is not configured. Set it up in Namzu first.')
			let request = catalogueRequests.get(provider)
			if (!request) {
				request = (deps.describeModels ?? describeProviderModels)(
					detected.entry.id,
					detected,
					catalogueController.signal,
				)
				catalogueRequests.set(provider, request)
				void request.finally(() => catalogueRequests.delete(provider)).catch(() => {})
			}
			const listing = await request
			if (closed) throw new Error('The connection is closed.')
			const choice = (await preferencesFor(sessionId, probe))?.providers[0]
			return desktopModelCatalogue(
				listing,
				detected.entry.defaultModel,
				choice?.id === provider ? choice.model : undefined,
				(model) =>
					canSelectModel(detected.entry, detected.apiKey, model) &&
					isOfferableModel(provider, model),
				detected.entry.label,
			)
		},
		selectProvider: async (sessionId, provider, model) => {
			if (!isEntityId(sessionId, 'session')) throw new Error('Invalid conversation id.')
			if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 400))
				throw new Error('Invalid model.')
			if (constructing.has(sessionId) || selecting.has(sessionId))
				throw new Error('Wait for this conversation to finish connecting.')
			selecting.add(sessionId)
			try {
				const probe = await sharedProbe()
				if (closed) throw new Error('The connection is closed.')
				const detected = probe.detected.find(({ entry }) => entry.id === provider)
				if (!detected) throw new Error('This provider is not configured. Set it up in Namzu first.')
				const selectedModel = model ?? detected.entry.defaultModel
				if (!isOfferableModel(provider, selectedModel))
					throw new Error('This model has no supported wire format. Choose a listed model.')
				if (!canSelectModel(detected.entry, detected.apiKey, selectedModel))
					throw new Error(
						'This model requires a credential for the selected provider. Configure it or choose a listed free model.',
					)
				const preferences = await preferencesFor(sessionId, probe)
				const live = records.get(sessionId)
				// A running conversation compares against what it actually runs on, which can be
				// behind its Pal's model after the Pal was changed.
				const previous = live ? { id: live.provider, model: live.model } : preferences?.providers[0]
				const palBinding = await deps.palBinding?.(live?.cwd ?? process.cwd(), sessionId)
				const palModel = palBinding?.definition.model
				// A Pal never runs on Auto, so its picks neither end Auto nor force a rebuild for it.
				const wasAuto = autoIsActive(sessionId, bootstrapCtx.config, palBinding != null)
				// Hand-picking the model that happens to be running still ends Auto, which needs a rebuild.
				if (
					!wasAuto &&
					previous?.id === provider &&
					(previous.model ?? detected.entry.defaultModel) === (model ?? detected.entry.defaultModel)
				)
					return
				const existing = records.get(sessionId)
				if (existing?.route || existing?.session.jobs?.().some((job) => job.status === 'running'))
					throw new Error('Stop this conversation’s active work before changing its model.')
				if (existing) {
					if (existing.retrySettings) retryCarry.set(sessionId, existing.retrySettings)
					records.delete(sessionId)
					contextReads.delete(sessionId)
					contextTracker.forget(sessionId)
					try {
						await existing.session.close()
					} finally {
						if (existing.conversations) closeSessions(existing.conversations)
					}
				}
				if (closed) throw new Error('The connection is closed.')
				// A model picked by hand turns Auto off for this conversation until Auto is chosen again.
				if (wasAuto) autoChoices.set(sessionId, false)
				// Choosing what the Pal already uses is following the Pal, not a hand pick.
				if (palModel && palModel.provider === provider && palModel.model === selectedModel) {
					selections.delete(sessionId)
					return
				}
				selections.set(sessionId, {
					...(preferences ?? { version: 3, subagents: { active: [] } }),
					providers: [
						{
							id: detected.entry.id,
							...(model ? { model } : {}),
							...accountPin(preferences, detected.entry.id),
						},
						...(preferences?.providers.slice(1).filter((item) => item.id !== detected.entry.id) ??
							[]),
					],
				})
			} finally {
				selecting.delete(sessionId)
			}
		},
		selectAuto: async (sessionId) => {
			if (!isEntityId(sessionId, 'session')) throw new Error('Invalid conversation id.')
			if (constructing.has(sessionId) || selecting.has(sessionId))
				throw new Error('Wait for this conversation to finish connecting.')
			selecting.add(sessionId)
			try {
				if (closed) throw new Error('The connection is closed.')
				const existing = records.get(sessionId)
				const pal = (await deps.palBinding?.(existing?.cwd ?? process.cwd(), sessionId)) != null
				if (pal)
					throw new Error('Auto is not available in a Pal conversation. A Pal keeps its own model.')
				if (!autoAvailable(bootstrapCtx.config, false))
					throw new Error(
						'Auto is not set up. It needs a routing block in your user config (~/.namzu/config.yaml) that says which models to pick from. See docs/cli/auto-model-routing.md.',
					)
				if (autoIsActive(sessionId, bootstrapCtx.config, false)) return
				if (existing?.route || existing?.session.jobs?.().some((job) => job.status === 'running'))
					throw new Error('Stop this conversation’s active work before changing its model.')
				if (existing) {
					if (existing.retrySettings) retryCarry.set(sessionId, existing.retrySettings)
					records.delete(sessionId)
					contextReads.delete(sessionId)
					contextTracker.forget(sessionId)
					try {
						await existing.session.close()
					} finally {
						if (existing.conversations) closeSessions(existing.conversations)
					}
				}
				autoChoices.set(sessionId, true)
			} finally {
				selecting.delete(sessionId)
			}
		},
		contextUsage: async (sessionId, detail) => {
			const record = records.get(sessionId)
			const figures = contextTracker.figures(sessionId)
			if (!record || !figures?.windowTokens || figures.windowTokens <= 0) return null
			let reads = contextReads.get(sessionId)
			if (!reads || reads.version !== figures.version) {
				reads = {
					version: figures.version,
					lists: await discoverContextLists({
						cwd: record.cwd,
						skillsConfig: record.skillsConfig,
					}),
					files: new Map(),
				}
				contextReads.set(sessionId, reads)
			}
			const files = reads.files
			const inventory = record.session.contextInventory?.()
			const gathering = await gatherContext({
				context: {
					tokens: figures.tokens ?? 0,
					windowTokens: figures.windowTokens,
					measured: figures.measuredBy === 'provider',
					...(figures.windowSource ? { windowSource: figures.windowSource } : {}),
				},
				autoCompact: true,
				...(inventory?.systemPrompt ? { systemPrompt: inventory.systemPrompt } : {}),
				tools: inventory?.tools ?? [],
				...(inventory?.deferredTools ? { deferredTools: inventory.deferredTools } : {}),
				// The history is not read here: the kernel's own figure already covers it.
				messages: [],
				instructionFiles: record.session.instructionFiles ?? [],
				mcpInstructions: (record.session.mcpStatus?.().connected ?? []).flatMap((server) =>
					server.instructions ? [server.instructions] : [],
				),
				skills: reads.lists.skills,
				agents: reads.lists.agents,
				displayPath: (path) => displayPath(path, record.cwd),
				readText: async (path) => {
					const known = files.get(path)
					if (known !== undefined) return known
					const text = await readFile(path, 'utf8')
					files.set(path, text)
					return text
				},
			})
			return buildContextReport({
				sessionId,
				detail,
				figures,
				autoCompact: true,
				gathering,
			})
		},
		jobs: (sessionId) => records.get(sessionId)?.session.jobs?.() ?? [],
		readJob: (sessionId, jobId) => {
			const session = records.get(sessionId)?.session
			if (!session?.readJob) throw new Error('This conversation has no background shell.')
			return session.readJob(jobId)
		},
		stopJob: async (sessionId, jobId) => {
			const session = records.get(sessionId)?.session
			if (!session?.stopJob) throw new Error('This conversation has no background shell.')
			return await session.stopJob(jobId)
		},
		close: async () => {
			closed = true
			for (const inbox of liveInputs.values()) inbox.close()
			liveInputs.clear()
			pluginOverrides.clear()
			catalogueController.abort(new Error('The connection is closed.'))
			const owned = [...records.values()]
			records.clear()
			const results = await Promise.allSettled(
				owned.map(async (record) => {
					try {
						await record.session.close()
					} finally {
						if (record.conversations) closeSessions(record.conversations)
					}
				}),
			)
			const failures = results
				.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
				.map((result) => result.reason)
			if (failures.length > 0) throw new AggregateError(failures, 'Failed to close ACP sessions.')
		},
	}
}

/** Try both resource owners even if conversation shutdown fails. */
export async function closeAcpResources(
	runtime: Pick<CliAcpRuntime, 'close'>,
	closePals: () => Promise<void> = closeCliPalRuntime,
): Promise<void> {
	const failures: unknown[] = []
	try {
		await runtime.close()
	} catch (error) {
		failures.push(error)
	}
	try {
		await closePals()
	} catch (error) {
		failures.push(error)
	}
	if (failures.length) throw new AggregateError(failures, 'ACP cleanup failed.')
}

/** What this application says about itself in `initialize`: its version, and the desktop contract for a desktop host. */
export function acpKernelFacts(desktop: boolean): AcpHostKernelFacts {
	return {
		commandLine: readPackageVersion(),
		...(desktop ? { desktopContract: DESKTOP_CONTRACT } : {}),
	}
}

/**
 * Every extension method a host started for the desktop application serves: the
 * project, conversation, provider and Pal methods, plus the terminal methods when
 * the host owns terminals. One place builds the table, so the guard of the desktop
 * contract starts the same host the real one does.
 */
export function desktopServerExtensions(
	runtime: CliAcpRuntime,
	cwd: string,
	server: Pick<ACPServer, 'getSessionCwd' | 'retrySession'>,
	palInboxStart?: CliPalInboxStarter,
	terminals?: Pick<TerminalHost, 'extensions'>,
	limits?: Pick<LimitsFeed, 'refresh'>,
	extensions?: Readonly<Record<string, (params: Record<string, unknown>) => unknown>>,
): Readonly<Record<string, (params: Record<string, unknown>) => unknown>> {
	return {
		...createDesktopHostExtensions(
			runtime,
			cwd,
			(id) => server.getSessionCwd(id),
			(id, turnId, checkpointId, options) => server.retrySession(id, turnId, checkpointId, options),
			undefined,
			undefined,
			palInboxStart,
			limits,
		),
		...terminals?.extensions,
		...(extensions ?? createExtensionsRpc(() => sharedExtensionHost('desktop'))),
	}
}

export async function runAcpCommand(ctx: CommandContext, desktop = false): Promise<number> {
	const transport = new ServerStdioTransport()
	// Desktop only: how full each conversation is, and when it is being compacted.
	// The shared bridge carries neither, so the host announces them itself.
	let announcingUsage = true
	const announce = (method: string, params: Record<string, unknown>) => {
		if (announcingUsage) void transport.send({ jsonrpc: '2.0', method, params })
	}
	const usageFeed: UsageFeed | undefined = desktop
		? createUsageFeed({
				notify: announce,
				now: () => Date.now(),
				schedule: (run, ms) => {
					const timer = setTimeout(run, ms)
					timer.unref?.()
					return () => clearTimeout(timer)
				},
			})
		: undefined
	// Desktop only: what each provider in use says about its account. Read from responses already
	// made, or asked at most once a minute; held in memory and never logged.
	const limitsFeed: LimitsFeed | undefined = desktop
		? createLimitsFeed({
				sources: limitsSources,
				spend: localSpendEstimate,
				notify: announce,
				now: () => Date.now(),
			})
		: undefined
	const runtime = withCliHarnesses(
		createCliAcpRuntime(ctx, DEFAULT_RUNTIME_DEPS, {
			computerUse: desktop,
			...(desktop
				? {
						observeComputer: (id: string, seen: ComputerUseObservation) =>
							announce(COMPUTER_FRAME_NOTIFICATION, { sessionId: id, ...seen }),
					}
				: {}),
			...(desktop ? { announce } : {}),
			...(desktop
				? (() => {
						const bridge = desktopPreferencesBridge(process.env, announce)
						return bridge ? { desktopPreferences: bridge } : {}
					})()
				: {}),
			...(usageFeed
				? {
						observeEvent: (id, event) => {
							usageFeed.observe(id, event)
							if (event.type === 'turn_completed' || event.type === 'turn_failed')
								void limitsFeed?.noteTurnEnd()
							announceOutcome(id, event, announce)
						},
					}
				: {}),
		}),
		process.cwd(),
	)
	// The terminals this process hosts for the desktop. Their output travels as
	// notifications on the same stream, written in the order it was produced; once
	// shutdown begins nothing more is written to a client that may already be gone.
	let announcing = true
	const terminals: TerminalHost | undefined = desktop
		? createTerminalHost({
				cwd: process.cwd(),
				notify: (method, params) => {
					if (announcing) void transport.send({ jsonrpc: '2.0', method, params })
				},
			})
		: undefined
	const palInboxStart = desktop
		? createPalInboxStarter(() => resolveTrustedProjectContext(ctx, process.cwd()))
		: undefined
	const hostConfig = (() => {
		try {
			return resolveTrustedProjectContext(ctx, process.cwd()).config
		} catch {
			return ctx.config
		}
	})()
	const server: ACPServer = new ACPServer({
		supportsPromptAttachments: true,
		supportsPromptOptions: true,
		supportsPromptPasted: true,
		// Only the modes the configuration leaves open, so a client does not offer one
		// the engine then refuses. `assertModeAllowed` below still holds the line.
		// The list follows the folder this host was started in: Desktop starts one host per
		// project, in the project's folder, so that is the project's own configuration.
		promptPermissionModes: advertisedPromptModes(hostConfig),
		supportsTaskNotifications: desktop,
		transport,
		gateway: runtime.gateway,
		commands: new HostCommandRegistry(),
		presenter: runtime.presenter,
		agentInfo: { name: 'namzu', version: readPackageVersion() },
		// The two facts this application adds to what the engine says about itself.
		kernelFacts: acpKernelFacts(desktop),
		...(desktop
			? {
					extensions: desktopServerExtensions(
						runtime,
						process.cwd(),
						{
							getSessionCwd: (id) => server.getSessionCwd(id),
							retrySession: (id, turnId, checkpointId, options) =>
								server.retrySession(id, turnId, checkpointId, options),
						},
						palInboxStart,
						terminals,
						limitsFeed,
					),
				}
			: {}),
	})

	await server.start()
	if (desktop) {
		startDesktopExtensions((method, params) => {
			if (announcing) void transport.send({ jsonrpc: '2.0', method, params })
		})
	}
	// Bootstrap context deliberately does not activate the project yet, so it
	// cannot emit the project-aware boot narrative. Still make the live protocol
	// owner observable on stderr; stdout remains exclusively JSON-RPC frames.
	cliLogger().info('ACP protocol server started')
	// The engine is ended by its host, often by a signal, and the cache is
	// otherwise written only on a graceful exit: write it once the first
	// requests have been answered so the next start is warm either way.
	flushCompileCacheWhenIdle()
	try {
		// Held open until stdin ends. The client owns the lifetime — it spawned
		// this process — so there is no idle timeout to get wrong.
		await new Promise<void>((resolve) => {
			const finish = () => {
				process.stdin.off('end', finish)
				process.stdin.off('close', finish)
				resolve()
			}
			process.stdin.once('end', finish)
			process.stdin.once('close', finish)
		})
	} finally {
		announcing = false
		announcingUsage = false
		usageFeed?.close()
		try {
			if (desktop) await stopDesktopExtensions()
			await terminals?.close()
			await palInboxStart?.close()
		} finally {
			try {
				await server.stop()
			} finally {
				await closeAcpResources(runtime)
			}
		}
	}
	return 0
}

/**
 * The arguments `namzu acp` takes: `--desktop` and nothing else. The desktop
 * application starts the host as `acp --desktop`, so this is the parser that
 * flag lives in, and a test of the desktop contract calls it.
 */
export function parseAcpArgs(rawArgs: readonly string[]): { desktop: boolean } {
	if (rawArgs.some((arg) => arg !== '--desktop'))
		throw new Error('Unknown ACP argument. Use namzu acp --help.')
	return { desktop: rawArgs.includes('--desktop') }
}

export const acpCommand: CommandDef = {
	name: 'acp',
	description: 'Speak the agent-client protocol over this process’s stdio',
	passThrough: true,
	help: 'Usage: namzu acp [--desktop]\nSpeak ACP over stdio. --desktop enables scoped operator methods for the Namzu desktop application.',
	handler: async ({ ctx, rawArgs }) => {
		return runAcpCommand(ctx, parseAcpArgs(rawArgs).desktop)
	},
}
