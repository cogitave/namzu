/**
 * TUI root. Composes the banner, transcript, composer, status bar, and
 * the first-run provider picker overlay.
 *
 * Session lifecycle:
 *   1. Mount → probeAgentSession() (readPreferences + discoverProviders).
 *   2. If a v2 preferences file exists → createAgentSession(prefs, detected) → ready.
 *   3. If preferences missing OR v1 (legacy) → show <Picker/>.
 *      After picker submit, writePreferences + hydrate session.
 *   4. If discovery returned zero providers → show <Picker/> in
 *      empty-state mode (explains where to put credentials).
 */

import {
	DiskMessageFeedbackStore,
	HostCommandRegistry,
	kernelHostCommands,
	type CostInfo,
	type ImageAttachment,
	type Message,
	type MessageId,
	type RunId,
	createAssistantMessage,
	createUserMessage,
	isCompactionMessage,
} from '@namzu/sdk'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { join, relative } from 'node:path'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	beginSubscriptionLogin,
	clearStoredSubscriptionCredential,
	credentialsPath,
	type DetectedProvider,
	type Preferences,
	type ProviderId,
	primaryProvider,
	readStoredSubscriptionCredential,
	type SubscriptionLogin,
	writePreferences,
} from '../integrations/providers/index.js'
import { writeClipboardText } from '../integrations/clipboard/text.js'
import { describeLoginOutcome, describeLoginStart, describeLogout } from './login-prompt.js'
import { openInBrowser } from './open-browser.js'
import { isTrusted, trustDir } from '../integrations/trust/store.js'
import { appendMemory, composeMemoryPrompt, readMemory } from '../memory/store.js'
import { composeSkillsPrompt, discoverSkills, loadSkillBody } from '../skills/store.js'
import { checkUpdates } from '../integrations/updates.js'
import { type ActiveTool, LiveActivity, formatElapsed } from './LiveActivity.js'
import { bottomSpacerRows } from './bottom-spacer.js'
import { expandFileMentions } from './mentions.js'
import { Composer } from './Composer.js'
import { TrustPrompt } from './TrustPrompt.js'
import {
	NAMZU_MARK,
	NAMZU_MARK_COLOR,
	NAMZU_WORDMARK,
	NAMZU_WORDMARK_GRADIENT,
	NAMZU_WORDMARK_MIN_WIDTH,
} from './logo.js'
import { PermissionOverlay } from './PermissionOverlay.js'
import { approvalIsDeliberate } from './consent-timing.js'
import { Picker } from './Picker.js'
import { type ContextFill, StatusBar } from './StatusBar.js'
import { Transcript, willCollapse } from './Transcript.js'
import { liveWindow, transcriptLines } from './live-window.js'
import {
	type CliSessions,
	type RecentConversation,
	appendMessages,
	forkConversation,
	listRecent,
	loadConversation,
	openSessions,
	replaceConversation,
	setTitle,
	startConversation,
	titleOf,
} from '../integrations/sessions/store.js'
import {
	type AgentEvent,
	type AgentSession,
	type PermissionDecision,
	type PermissionRequest,
	type RunScope,
	createAgentSession,
	probeAgentSession,
} from './agent.js'
import { ResumePicker } from './ResumePicker.js'
import { type UserCommand, discoverUserCommands } from '../user-commands/store.js'
import {
	type SlashContext,
	hostCommandNames,
	kernelCommandDescriptors,
	mergeHostCommands,
	renderOutcome,
	runSlash,
	reviewPrompt,
} from './slashCommands.js'
import { splitCompleteBlocks } from './stream-blocks.js'
import { theme } from './theme.js'
import type { TranscriptMessage, TuiContext } from './types.js'
import { keepRecentRows } from './compact-transcript.js'
import { renderWorkspaceDiff, workspaceDiff } from './workspace-diff.js'

export interface AppProps {
	readonly ctx: TuiContext
}

type LifecyclePhase = 'trust' | 'probing' | 'picker' | 'ready' | 'unhealthy' | 'resume'

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
	pending?: string
	/** Only a normal run end makes this text the next `/copy` target. */
	completed: boolean
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

/** A running tool tracked internally: the live row's fields plus what we need
 *  to commit it on completion (the tool name for matching, the call-time diff). */
type RunningTool = ActiveTool & {
	readonly toolName: string
	readonly detail?: readonly string[]
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

export function App({ ctx }: AppProps) {
	const { exit } = useApp()
	const { stdout, write: writeStdout } = useStdout()
	/**
	 * The last assistant message id the run reported, for `/feedback`.
	 *
	 * A ref rather than state: nothing renders it, and making it state would
	 * re-render the transcript on every delta — the exact cost the `pending`
	 * buffering two hundred lines down exists to avoid.
	 */
	const lastAssistantMessage = useRef<{ runId: string; messageId: string } | null>(null)
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
	const [activeSkills, setActiveSkills] = useState<ReadonlyArray<{ name: string; body: string }>>(
		[],
	)
	// Read when the session comes up rather than on every keystroke: the
	// autocomplete dropdown consults this on each character, and a `readdirSync`
	// per keypress is a cost nobody asked for. A file added mid-session is
	// picked up by `/model` (which re-hydrates) or a restart.
	const [userCommands, setUserCommands] = useState<readonly UserCommand[]>([])
	const [usage, setUsage] = useState<{ totalTokens: number; cost: CostInfo } | null>(null)
	// Context fill, straight from the kernel and held apart from `usage` —
	// they are different quantities and conflating them is what made the
	// gauge climb with turn count instead of with context.
	const [context, setContext] = useState<ContextFill | null>(null)
	// Tools currently executing — rendered live (spinner + elapsed) below the
	// transcript, then committed as static lines on completion.
	const [activeTools, setActiveTools] = useState<readonly ActiveTool[]>([])
	// Bumped to reset the <Static> transcript log (on /clear and /resume).
	const [resetKey, setResetKey] = useState<number>(0)
	/**
	 * How many finalized rows have been printed to scrollback.
	 *
	 * The floor under the live window, carried between renders so the split can
	 * only ever move forward. Reset with the static log itself — after `/clear`
	 * nothing has been printed under the new log, and a floor left behind would
	 * hold the window shut for the length of the next conversation.
	 */
	const settledRef = useRef<number>(0)
	// Messages typed while a turn is running — auto-sent when it settles.
	const [queued, setQueued] = useState<readonly string[]>([])
	/** Manual compaction owns the conversation snapshot until its durable write lands. */
	const compactingRef = useRef(false)
	const [compacting, setCompacting] = useState(false)
	const [resumeList, setResumeList] = useState<readonly RecentConversation[]>([])
	const [selectedResume, setSelectedResume] = useState<number>(0)
	const exitArmedRef = useRef<boolean>(false)
	const abortRef = useRef<AbortController | null>(null)
	/**
	 * The sign-in attempt awaiting its authorization code, if any.
	 *
	 * A ref and not state: nothing renders from it, and a re-render between
	 * `/login` and `/login <address>` must not lose the verifier — without
	 * which the code that comes back cannot be exchanged for anything.
	 */
	const loginRef = useRef<SubscriptionLogin | null>(null)
	const runProbeRef = useRef<(() => Promise<void>) | null>(null)
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
	 * Bumped ONLY by `resumeConversation`. `/clear` resets the transcript too and
	 * stays in the same conversation — its turn's rows are still that
	 * conversation's rows and must keep arriving.
	 */
	const conversationGenRef = useRef<number>(0)
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
	// already-printed lines don't linger above fresh content (/clear, /resume).
	//
	// The block numbering resets with it and needs no separate step: the numbers
	// live on the rows, so emptying `messages` takes them with it. A number that
	// outlived the row it named would resolve `/expand 3` to output the operator
	// can no longer see anywhere, which is the failure this surface is being
	// cleaned of, one layer up.
	const resetTranscript = useCallback(() => {
		if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
		// The scrollback floor goes with the log it counted. <Static> is remounted
		// by the key below and has emitted nothing again; a floor that survived
		// would keep the next conversation's rows out of the live window.
		settledRef.current = 0
		setResetKey((k) => k + 1)
	}, [])

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
						? { detailRef: prev.filter((m) => m.detailRef !== undefined).length + 1 }
						: {}),
				},
			])
			return id
		},
		[nextId],
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

	// Open the SDK session store + start a fresh conversation once. Best-effort:
	// on failure persistence is simply unavailable and the chat still works.
	const ensureSessions = useCallback(async (): Promise<RunScope | undefined> => {
		if (scopeRef.current) return scopeRef.current
		try {
			const sessions = await openSessions(ctx.cwd)
			const sessionId = await startConversation(sessions)
			sessionsRef.current = sessions
			scopeRef.current = {
				sessionId,
				topicId: sessions.topicId,
				projectId: sessions.projectId,
				tenantId: sessions.tenantId,
			}
			return scopeRef.current
		} catch {
			return undefined
		}
	}, [ctx.cwd])

	const hydrateSession = useCallback(
		async (prefs: Preferences, detectedNow: readonly DetectedProvider[]) => {
			const scope = await ensureSessions()
			const s = await createAgentSession(prefs, detectedNow, {
				scope,
				cwd: ctx.cwd,
				rules: ctx.rules,
				...(ctx.mcpServers ? { mcpServers: ctx.mcpServers } : {}),
				...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
			})
			// Re-hydration (a provider switch via /model) builds a second session;
			// without this the first one's tool-server child processes stay alive
			// for the rest of the TUI's life.
			void previousSessionRef.current?.close()
			previousSessionRef.current = s
			setSession(s)
			setUserCommands(
				discoverUserCommands({
					cwd: ctx.cwd,
					// Builtins are reserved: a `help.md` must not take over `/help`.
					// Passing the names here is what lets the loader tell its author
					// the file is shadowed instead of leaving it silently unused.
					reserved: hostCommandNames(),
				}),
			)
			setCurrentProvider(primaryProvider(prefs).id)
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
						`Project instructions: ${s.instructionFiles.map((p) => relative(ctx.cwd, p) || p).join(', ')}`,
					)
				}
				for (const skip of s.skippedInstructionFiles) {
					pushMessage(
						'system',
						`Skipped ${relative(ctx.cwd, skip.path) || skip.path}: ${skip.reason}`,
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
		[ctx.cwd, ctx.rules, pushMessage],
	)

	/**
	 * Sign in to a subscription without leaving namzu.
	 *
	 * Two calls, one command. Bare `/login` starts an attempt and parks it in
	 * `loginRef`; `/login <address>` finishes that one. Nothing here parses the
	 * argument — `slashCommands` already decided which of the two this is.
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
				pushMessage('system', describeLoginOutcome(outcome))
				if (outcome.ok) await runProbeRef.current?.()
				return
			}

			loginRef.current?.cancel()
			loginRef.current = null
			let start: SubscriptionLogin
			try {
				start = await beginSubscriptionLogin()
			} catch (err) {
				pushMessage(
					'system',
					`Could not start a sign-in: ${err instanceof Error ? err.message : String(err)}`,
				)
				return
			}
			loginRef.current = start
			pushMessage(
				'system',
				describeLoginStart({
					url: start.url,
					loopback: start.loopback,
					browserOpened: openInBrowser(start.url),
				}),
			)
			// The automatic half, when there is one. Not awaited by the caller:
			// the composer stays live throughout, so the operator can paste
			// instead — or type anything else — while this waits.
			const waiting = start.waitForCallback()
			if (!waiting) return
			const outcome = await waiting
			if (loginRef.current !== start) return // superseded, or finished by paste
			loginRef.current = null
			start.cancel()
			// A cancelled listener resolves to a refusal, and saying "sign-in
			// failed" when the operator finished it another way would be a lie
			// about their own successful login.
			if (!outcome.ok && outcome.reason.includes('cancelled')) return
			pushMessage('system', describeLoginOutcome(outcome))
			if (outcome.ok) await runProbeRef.current?.()
		},
		[pushMessage],
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
	 * It uses the browser route only. There is no paste input on this screen,
	 * and rather than invent one — a second text field beside the credential
	 * one, on the screen an operator reaches when they are already stuck — the
	 * no-browser case is handed to `namzu login`, which reads the pasted
	 * address from standard input and exists for exactly that machine.
	 */
	const startLoginFromPicker = useCallback(async () => {
		loginRef.current?.cancel()
		loginRef.current = null
		let start: SubscriptionLogin
		try {
			start = await beginSubscriptionLogin()
		} catch (err) {
			setPickerNotice(
				`Could not start a sign-in: ${err instanceof Error ? err.message : String(err)}`,
			)
			return
		}
		loginRef.current = start
		setPickerNotice(
			describeLoginStart({
				url: start.url,
				loopback: start.loopback,
				browserOpened: openInBrowser(start.url),
				// Named for THIS screen. Telling someone at the picker to type a
				// slash command is what made the feature unreachable; telling them
				// to run a command in another terminal is something they can do
				// from where they are sitting.
				completionHint: 'run "namzu login" in a terminal and paste it there',
			}),
		)
		const waiting = start.waitForCallback()
		if (!waiting) return
		const outcome = await waiting
		if (loginRef.current !== start) return
		loginRef.current = null
		start.cancel()
		if (!outcome.ok && outcome.reason.includes('cancelled')) return
		setPickerNotice(describeLoginOutcome(outcome))
		if (outcome.ok) await runProbeRef.current?.()
	}, [])

	const runProbe = useCallback(async () => {
		try {
			const probe = await probeAgentSession()
			setDetected(probe.detected)
			if (probe.needsRepickReason) {
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
				setKeyEntryFor(probe.credentialGap.providerId)
				pushMessage('system', probe.credentialGap.reason)
				setPickerNotice(probe.credentialGap.reason)
				setPhase('picker')
				return
			}
			if (probe.preferences) {
				await hydrateSession(probe.preferences, probe.detected)
				return
			}
			setPhase('picker')
		} catch (err) {
			setPhase('unhealthy')
			pushMessage(
				'system',
				`Failed to probe agents: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}, [hydrateSession, pushMessage])

	// `startOrFinishLogin` is declared above `runProbe` and calls it, so it
	// reads the current one through a ref rather than closing over a stale
	// binding or forcing the two into a declaration order that reads backwards.
	runProbeRef.current = runProbe

	// Trust gate runs first: don't touch the folder until the user trusts it.
	useEffect(() => {
		if (isTrusted(ctx.cwd)) {
			void runProbe()
		} else {
			setPhase('trust')
		}
	}, [ctx.cwd, runProbe])

	// Starts the settle window when the gate is on screen, and clears it when it
	// leaves so a later stray key can never be measured against a stale one.
	useEffect(() => {
		trustShownAtRef.current = phase === 'trust' ? Date.now() : null
	}, [phase])

	const acceptTrust = useCallback(() => {
		try {
			trustDir(ctx.cwd)
		} catch {
			// Non-fatal: proceed for this session even if persisting failed.
		}
		setPhase('probing')
		void runProbe()
	}, [ctx.cwd, runProbe])

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
		rows: process.stdout.rows,
		columns: process.stdout.columns,
		furnitureRows: LIVE_FURNITURE_ROWS,
		settled: settledRef.current,
	})
	settledRef.current = window.settled

	// Blank rows above the composer, while the transcript is short enough that
	// the answer is knowable. `liveRows` is the furniture beneath the transcript
	// PLUS the live window above it — the window is part of the live region, and
	// leaving it out would have the spacer padding room that is already taken.
	const spacerRows =
		phase === 'ready'
			? bottomSpacerRows({
					rows: process.stdout.rows,
					columns: process.stdout.columns,
					transcript: transcriptLines(finalized.slice(0, window.settled)),
					liveRows: LIVE_FURNITURE_ROWS + window.rows,
				})
			: 0

	// One merged vocabulary for the session: this host's own commands plus
	// whatever the kernel's registry reports. Built here so `/help`, the
	// autocomplete and the dispatcher all answer from the same list — three
	// places that used to read one hardcoded array and would otherwise
	// disagree the moment a capability added a command.
	const hostCommands = mergeHostCommands(kernelCommandDescriptors())

	const slashCtx: SlashContext = {
		builtins: hostCommands,
		lastAssistantMessageId: () => lastAssistantMessage.current?.messageId ?? null,
		// Called when `/tools` renders, not read here — the same shape, and the
		// same reason, as `neverPrompted` below.
		availableTools: () => session?.toolNames() ?? [],
		// From the session, not re-resolved: resolving builds a provider, and a
		// second one would describe a different sandbox than the run is using.
		sandbox: session?.sandbox ?? null,
		mcp: session ? { connected: session.mcpConnected, failed: session.mcpFailed } : null,
		providerSummary: session?.providerSummary ?? null,
		modelSummary: session?.modelSummary ?? null,
		// The same state the status bar reads, unformatted. `/cost` prints exact
		// figures where the bar abbreviates to fit.
		usage,
		permissions: {
			skipPermissions: ctx.skipPermissions === true,
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
			pushMessage('system', `Could not list conversations: ${err instanceof Error ? err.message : String(err)}`)
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
		if (permissionResolveRef.current) resolvePermission({ kind: 'reject', feedback: 'User interrupted.' })
		const ac = abortRef.current
		if (!ac) return false
		ac.abort()
		// Dropped now so a second interrupt does not re-abort, and the queue with
		// it: interrupting means stop, not "run the next one".
		abortRef.current = null
		setQueued([])
		clearActiveTools()
		setState('idle')
		return true
	}, [clearActiveTools, resolvePermission])

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
				pushMessage('system', `Could not resume: ${err instanceof Error ? err.message : String(err)}`)
				return
			}
			resumeCommittedRef.current = false
			setPhase('ready')
			const restored = msgs.flatMap<TranscriptMessage>((message) => {
				if (message.role === 'user' || message.role === 'assistant') {
					return [
						{
							id: nextId(),
							role: message.role,
							content: typeof message.content === 'string' ? message.content : '',
						},
					]
				}
				if (message.role === 'system' && isCompactionMessage(message.content)) {
					return [
						{
							id: nextId(),
							role: 'system' as const,
							content: 'Earlier turns are represented by the compacted summary below.',
							glyph: '⌫',
							detail: summaryDetail(message),
						},
					]
				}
				return []
			})
			const interrupted = interruptTurn()
			conversationGenRef.current += 1
			resetTranscript()
			setMessages(restored)
			modelHistoryRef.current = msgs
			const persistedOutput = latestAssistantOutput(msgs)
			lastCompletedOutputRef.current = persistedOutput
				? { text: persistedOutput, provenance: 'persisted' }
				: null
			scope.sessionId = conv.id // new turns now attribute to the resumed session
			pushMessage('system', `Resumed: ${conv.title}`)
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
		[interruptTurn, nextId, pushMessage, resetTranscript],
	)

	/**
	 * `/title`: read or set the name this conversation appears under.
	 *
	 * A bare `/title` asks rather than clears. Erasing a name by pressing
	 * enter on a half-typed command is the kind of loss nobody notices until
	 * `/resume` is a list of opening messages again.
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
					pushMessage(
						'system',
						current !== undefined
							? `This conversation is named "${current}". /title <name> renames it; /title clear removes the name.`
							: 'This conversation has no name, so /resume lists it by its opening message — which stops describing it as the conversation moves on. /title <name> fixes that.',
					)
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
		[ensureSessions, pushMessage],
	)

	/**
	 * `/fork`: continue in a copy, leaving this conversation where it is.
	 *
	 * Refused while a turn is running, rather than interrupted like `/resume`
	 * does. The two look similar and are not: `/resume` LEAVES a conversation,
	 * so an interrupted reply landing in the one being left is where it
	 * belongs. A fork stays here — the reply would land in the original, the
	 * screen would go on showing it, and the copy would be missing the last
	 * thing the operator watched arrive.
	 */
	const doFork = useCallback(async () => {
		const sessions = sessionsRef.current ?? (await ensureSessions(), sessionsRef.current)
		const scope = scopeRef.current
		if (!sessions || !scope) {
			pushMessage('system', 'Conversation history is unavailable in this folder.')
			return
		}
		if (abortRef.current) {
			pushMessage(
				'system',
				'A turn is still running. Forking now would copy a conversation whose last reply is not in it yet — press esc to stop it, then fork.',
			)
			return
		}
		const original = scope.sessionId
		try {
			const forked = await forkConversation(sessions, original)
			// The transcript on screen is already the fork's history, so nothing
			// is reloaded or reset. Only where the NEXT turn is written changes.
			scope.sessionId = forked.id
			pushMessage(
				'system',
				`Forked into "${forked.title}" — ${forked.copied} message(s) copied. This screen continues in the copy; ${original} is unchanged and still in /resume.`,
			)
		} catch (err) {
			pushMessage('system', `Could not fork: ${err instanceof Error ? err.message : String(err)}`)
		}
	}, [ensureSessions, pushMessage])

	// Bridge passed into session.send(): the agent calls this before a
	// non-read-only tool batch; it parks until the user presses y/n/a.
	const onPermission = useCallback(
		(req: PermissionRequest) =>
			new Promise<PermissionDecision>((resolve) => {
				permissionResolveRef.current = resolve
				permissionOpenedAtRef.current = Date.now()
				setPermission(req)
				setState('awaiting-permission')
			}),
		[],
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
						lastAssistantMessage.current = { runId: event.runId, messageId: event.messageId }
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
				case 'done':
					// `run_completed` is not synonymous with success: budgets,
					// cancellation and output guardrails arrive through this event too.
					// Missing remains a normal end for older producers, matching the
					// headless command's compatibility rule.
					st.completed = event.stopReason === undefined || event.stopReason === 'end_turn'
					closeAssistant()
					break
				case 'error':
					closeAssistant()
					if (event.message !== 'aborted') pushMessage('system', `Error: ${event.message}`)
					break
			}
		},
		[appendToMessage, finalizeMessage, flushStream, pushMessage],
	)

	const runTurn = useCallback(
		async (text: string, images?: readonly ImageAttachment[]) => {
			if (!session || !session.hasProvider) {
				pushMessage('system', session?.errorHint ?? 'Agent is not ready yet — give it a moment.')
				return
			}
			// `@path` mentions: the visible message keeps the readable token, but
			// the model receives the file contents inlined.
			const { sendText, attached } = expandFileMentions(text, ctx.cwd)
			const historyBeforeTurn = modelHistoryRef.current
			const userMessage = createUserMessage(sendText, images)
			const priorForSdk: Message[] = [...historyBeforeTurn, userMessage]

			const metaParts: string[] = []
			if (attached.length > 0)
				metaParts.push(`${attached.length} file${attached.length > 1 ? 's' : ''} attached`)
			if (images && images.length > 0)
				metaParts.push(`${images.length} image${images.length > 1 ? 's' : ''}`)
			pushMessage(
				'user',
				text,
				false,
				undefined,
				undefined,
				undefined,
				metaParts.length > 0 ? metaParts.join(' · ') : undefined,
			)
			setState('thinking')
			// The model interleaves text → tool → text across iterations; `applyEvent`
			// renders each one in order.
			const st: StreamState = { assistantId: null, text: '', pending: '', completed: false }
			const ac = new AbortController()
			abortRef.current = ac
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
			const destination = scopeRef.current?.sessionId ?? null
			const turnGeneration = conversationGenRef.current
			const stillHere = (): boolean => conversationGenRef.current === turnGeneration
			try {
				for await (const event of session.send(priorForSdk, {
					signal: ac.signal,
					// Bypass mode (--dangerously-skip-permissions / --yolo): omit the
					// permission callback so every tool batch auto-approves.
					onPermission: ctx.skipPermissions ? undefined : onPermission,
					extraSystem: composeSkillsPrompt(activeSkills) ?? undefined,
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
					if (stillHere()) applyEvent(event, st)
					else if (event.kind === 'delta') st.text += event.text
				}
			} catch (err) {
				// Reported only where it means something. In the conversation the
				// operator has moved on from, this row would be the same misplacement
				// the generation exists to stop — and it would be the more confusing
				// half of it, because an abort reads as an error.
				if (stillHere()) {
					// Flushed first: this path does not go through `applyEvent`, so
					// without it the partial answer the model had produced before
					// the failure would be discarded along with the turn.
					flushStream(st)
					if (st.assistantId) finalizeMessage(st.assistantId)
					pushMessage('system', `Error: ${err instanceof Error ? err.message : String(err)}`)
				}
			} finally {
				// One turn shape, used by both the next provider request and the durable
				// store. The visible transcript keeps the operator's readable `@file`
				// token; this message keeps what was actually sent, including expanded
				// contents and attachments.
				const turn: Message[] = [userMessage]
				if (st.text.trim().length > 0) turn.push(createAssistantMessage(st.text))
				// The screen belongs to the conversation on it, which after a
				// `/resume` is no longer this turn's. `interruptTurn` already did this
				// cleanup at the moment it decided to stop; repeating it here would
				// clear the state of whatever has started since.
				if (stillHere()) {
					modelHistoryRef.current = [...historyBeforeTurn, ...turn]
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
					permissionResolveRef.current = null
					permissionOpenedAtRef.current = null
					setPermission(null)
					clearActiveTools()
					setState('idle')
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
				const sessions = sessionsRef.current
				if (sessions && destination) {
					persistenceTailRef.current = persistenceTailRef.current.then(async () => {
						try {
							await appendMessages(sessions, destination, turn)
						} catch (err) {
							pushMessage(
								'system',
								`A turn was not saved to conversation ${destination}: ${
									err instanceof Error ? err.message : String(err)
								}. That conversation's history will not include it, and its next turn will not have it as context.`,
							)
						}
					})
				}
			}
		},
		[activeSkills, applyEvent, ctx.cwd, ctx.skipPermissions, finalizeMessage, onPermission, pushMessage, session],
	)

	const handleSubmit = useCallback(
		(value: string, images?: readonly ImageAttachment[]) => {
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
					case 'clear':
						setMessages([])
						resetTranscript()
						return
					case 'exit':
						exit()
						return
					case 'repick':
						// Opened as a choice, not as a repair. A launch-time refusal
						// left on screen here would explain a problem that has since
						// been solved — the session behind this picker is running.
						setPickerNotice(null)
						setKeyEntryFor(null)
						setPhase('picker')
						return
					case 'login':
						void startOrFinishLogin(slash.pasted)
						return
					case 'logout': {
						const path = credentialsPath()
						const had = readStoredSubscriptionCredential() !== null
						try {
							clearStoredSubscriptionCredential()
						} catch (err) {
							pushMessage(
								'system',
								`Could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
							)
							return
						}
						pushMessage('system', describeLogout(path, had))
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
					case 'load-skill': {
						const info = discoverSkills({ cwd: ctx.cwd }).find((s) => s.name === slash.name)
						if (!info) {
							pushMessage('system', `No skill named "${slash.name}". See /skills.`)
							return
						}
						try {
							const body = loadSkillBody(info)
							setActiveSkills((prev) => [
								...prev.filter((s) => s.name !== info.name),
								{ name: info.name, body },
							])
							pushMessage('system', `Activated skill: ${info.name}`)
						} catch (err) {
							pushMessage(
								'system',
								`Could not load skill "${slash.name}": ${err instanceof Error ? err.message : String(err)}`,
							)
						}
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
						const registry = new HostCommandRegistry()
						registry.register(kernelHostCommands({ allowedAgentIds: session?.agentIds ?? [] }))
						void (async () => {
							const outcome = await registry.dispatch(
								`/${slash.name} ${slash.args.join(' ')}`.trim(),
							)
							pushMessage(
								'system',
								outcome
									? renderOutcome(outcome)
									: `/${slash.name} is registered but this session cannot run it.`,
							)
						})()
						return
					}
					case 'feedback': {
						const target = lastAssistantMessage.current
						// Written under the same `<cwd>/.namzu` root the runs live
						// in, so a rating and the transcript it judges are one
						// directory apart and travel together.
						if (!target) {
							pushMessage('system', 'Nothing to rate yet.')
							return
						}
						const store = new DiskMessageFeedbackStore({
							rootDir: join(ctx.cwd, '.namzu', 'feedback'),
							runsDir: join(ctx.cwd, '.namzu', 'runs'),
						})
						const runId = target.runId as RunId
						const messageId = slash.messageId as MessageId
						// Fire-and-forget: this switch is synchronous, and the
						// transcript reports the outcome either way rather than
						// blocking a keystroke on a disk write.
						void (async () => {
							try {
								// A first rating expects nothing; a second replaces the
								// first, which is what a rater changing their mind does.
								// Read-then-write rather than blind overwrite, so two
								// raters on one message still collide loudly.
								const current = (await store.listMessageFeedback({ runId })).find(
									(r) => r.messageId === messageId,
								)
								const record = await store.putMessageFeedback({
									runId,
									messageId,
									rating: slash.rating,
									...(slash.note ? { note: slash.note } : {}),
									expectedVersion: current?.ownerVersion ?? 0,
								})
								pushMessage('system', `Recorded ${record.rating} for ${record.messageId}.`)
							} catch (err) {
								pushMessage(
									'system',
									`Could not record feedback: ${err instanceof Error ? err.message : String(err)}`,
								)
							}
						})()
						return
					}
					case 'review': {
						void (async () => {
							const diff = await workspaceDiff(ctx.cwd)
							if (diff === null) {
								pushMessage(
									'system',
									'Cannot review here — this is not a git repository, or git is unavailable.',
								)
								return
							}
							if (diff.stat.length === 0 && diff.untracked.length === 0) {
								// Refused rather than sent. A review request over an
								// unchanged tree burns a turn and comes back with a
								// review of nothing, which reads exactly like a review
								// of something.
								pushMessage('system', 'Nothing to review — the working tree is clean.')
								return
							}
							// Queued or run, the same two ways a typed message is. A
							// review composed while a turn is in flight must not jump
							// the queue, and must not be dropped either.
							const text = reviewPrompt(diff.stat, diff.untracked)
							if (state !== 'idle') setQueued((q) => [...q, text])
							else void runTurn(text, undefined)
						})()
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
						if (abortRef.current || state !== 'idle') {
							pushMessage(
								'system',
								'A turn is still running. Compacting now would summarize a conversation while its next message is being written — wait for it to finish, or press esc to stop it.',
							)
							return
						}
						if (compactingRef.current) return
						compactingRef.current = true
						setCompacting(true)
						setState('thinking')
						// Fire-and-forget, the same shape `feedback` above uses and for
						// the same reason: this switch is synchronous and the work is a
						// model call. The transcript reports the outcome either way.
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
										'Nothing to compact yet — this conversation is short enough that a summary would cost a model call and save nothing.',
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

						const result = writeClipboardText(target.text, {
							isTTY: stdout.isTTY,
							write: writeStdout,
						})
						switch (result.kind) {
							case 'request-sent':
								pushMessage(
									'system',
									`Copy request sent for the ${
										target.provenance === 'persisted'
											? 'latest persisted assistant output'
											: 'latest normally completed answer'
									} (${result.bytes.toLocaleString()} bytes). Terminal, multiplexer or remote-session policy may ignore OSC 52; if the clipboard did not change, enable terminal clipboard access.`,
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
									`Cannot send this answer to the terminal clipboard — it is ${result.bytes.toLocaleString()} bytes and the OSC 52 safety limit is ${result.limit.toLocaleString()}. Nothing was truncated.`,
								)
								break
							case 'write-failed':
								pushMessage(
									'system',
									`Could not send the terminal copy request: ${result.detail}`,
								)
								break
							default: {
								const exhaustive: never = result
								void exhaustive
							}
						}
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
			// A turn is in flight → queue the message; it auto-sends when idle.
			// (Queued messages are text-only; pasted images aren't carried.)
			if (state !== 'idle') {
				setQueued((q) => [...q, outgoing])
				return
			}
			void runTurn(outgoing, images)
		},
		[activeSkills, doResume, exit, nextId, pushMessage, runTurn, slashCtx, state],
	)

	// Drain the queue: when a turn settles (idle) and nothing is running,
	// send the next queued message automatically.
	useEffect(() => {
		if (state !== 'idle' || phase !== 'ready' || queued.length === 0 || abortRef.current) return
		const [next, ...rest] = queued
		setQueued(rest)
		if (next !== undefined) void runTurn(next)
	}, [state, phase, queued, runTurn])

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

	/**
	 * A credential the operator typed. Held in memory for this process only.
	 *
	 * Deliberately does NOT call `writePreferences`: preferences are a file, and
	 * the whole contract of this entry point is that nothing lands on disk. The
	 * provider choice is not persisted either, because persisting it would leave
	 * a preference pointing at a credential that will not exist next launch.
	 */
	const handleTypedCredential = useCallback(
		(credential: DetectedProvider, disposition: string) => {
			const next = [credential, ...detected.filter((d) => d.entry.id !== credential.entry.id)]
			setDetected(next)
			setKeyEntryFor(null)
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
			void hydrateSession(prefs, next)
		},
		[detected, hydrateSession, pushMessage],
	)

	const handlePickerSubmit = useCallback(
		(selection: { provider: string; model?: string }) => {
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
			void hydrateSession(prefs, detected)
		},
		[detected, hydrateSession, pushMessage],
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
		if (session?.hasProvider) {
			setPhase('ready')
			return
		}
		exit()
	}, [session, exit])

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
				if (key.ctrl && input === 'c') exit()
				return
			}
			// Resume picker owns the keyboard while open.
			if (phase === 'resume') {
				// Once a conversation is being read, the keyboard does nothing here.
				// The choice is already being acted on; a second Enter would start a
				// second read and an Esc would hand back a screen that is about to be
				// replaced regardless.
				if (resumeCommittedRef.current) return
				if (key.upArrow) setSelectedResume((i) => Math.max(0, i - 1))
				else if (key.downArrow) setSelectedResume((i) => Math.min(resumeList.length - 1, i + 1))
				else if (key.return) {
					const conv = resumeList[selectedResume]
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
					exit()
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
					exit()
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
		{ isActive: true },
	)

	// Background is left natural — we inherit the terminal's own background
	// and only theme the foreground. Forcing
	// a filled bg left mismatched patches around bordered areas, so we don't.
	return (
		<Box flexDirection="column">
			{/* Before the chat is ready (trust / picker / probing) the banner
			    lives in the live region. Once ready it moves into the <Static>
			    transcript as row 0, so it prints once to the top of scrollback
			    and messages flow beneath it (a live-region banner would be
			    pushed down as static output accumulates above it). */}
			{phase !== 'ready' ? (
				<Banner
					version={ctx.version}
					session={session}
					bypass={ctx.skipPermissions === true}
					cwd={ctx.cwd}
				/>
			) : null}
			<Box flexDirection="column" paddingX={1}>
				{phase === 'trust' ? (
					<TrustPrompt cwd={ctx.cwd} />
				) : phase === 'resume' ? (
					<ResumePicker conversations={resumeList} selected={selectedResume} />
				) : phase === 'picker' ? (
					<Picker
						detected={detected}
						currentProvider={currentProvider}
						currentModel={session?.modelSummary ?? null}
						onSubmit={handlePickerSubmit}
						onCancel={handlePickerCancel}
						onCredential={handleTypedCredential}
						onLogin={() => void startLoginFromPicker()}
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
								header={
									phase === 'ready' ? (
										<Banner
											version={ctx.version}
											session={session}
											bypass={ctx.skipPermissions === true}
											cwd={ctx.cwd}
										/>
									) : undefined
								}
							/>
						</TranscriptFrame>
						{/* Pushes the composer to the bottom of the viewport while the
						    transcript is short enough for that to be knowable. Returns
						    0 once the terminal is scrolling, where the composer is
						    already at the bottom and padding would push it out of
						    view. See `bottom-spacer.ts` for why the estimate is safe
						    only in this direction. */}
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
						<ComposerFrame
							focus={state === 'idle' && phase === 'ready'}
							hidden={permission !== null}
						>
							{queued.length > 0 && permission === null ? (
								<Box paddingX={1}>
									<Text color={theme.text.muted}>
										⏎ {queued.length} message{queued.length > 1 ? 's' : ''} queued — sending when
										ready
									</Text>
								</Box>
							) : null}
							<Composer
								disabled={phase !== 'ready' || state === 'awaiting-permission' || compacting}
								hidden={permission !== null}
								// A turn is running, so Esc is the interrupt and not
								// the composer's clear.
								escapeInterrupts={!compacting && (state === 'thinking' || state === 'tool')}
								onSubmit={handleSubmit}
								onNotice={(text) => pushMessage('system', text)}
								userCommands={userCommands}
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
						state={state}
						hint={
							compacting
								? 'compacting conversation — input is paused'
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
	bypass,
	cwd,
}: {
	readonly version: string
	readonly session: AgentSession | null
	readonly bypass: boolean
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
			{bypass ? (
				<Box marginTop={1}>
					<Text color={theme.status.error} bold>
						⚠ bypass permissions — tools run without asking
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
	const display =
		toolName.length > 0 ? toolName[0]?.toUpperCase() + toolName.slice(1) : toolName
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
	if (state !== 'idle') return 'agent is working — esc to interrupt'
	return '/help · @file / Ctrl+V to attach · Ctrl+C ×2 to exit'
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
