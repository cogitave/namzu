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

import type { ImageAttachment, Message } from '@namzu/sdk'
import { Box, Text, useApp, useInput } from 'ink'
import { relative } from 'node:path'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	type DetectedProvider,
	type Preferences,
	type ProviderId,
	primaryProvider,
	writePreferences,
} from '../integrations/providers/index.js'
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
import { Transcript, renderedDetailLines, willCollapse } from './Transcript.js'
import { createAssistantMessage, createUserMessage } from '@namzu/sdk'
import {
	type CliSessions,
	type RecentConversation,
	appendMessages,
	listRecent,
	loadConversation,
	openSessions,
	startConversation,
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
import { SLASH_COMMANDS, type SlashContext, runSlash } from './slashCommands.js'
import { theme } from './theme.js'
import type { TranscriptMessage, TuiContext } from './types.js'

export interface AppProps {
	readonly ctx: TuiContext
}

type LifecyclePhase = 'trust' | 'probing' | 'picker' | 'ready' | 'unhealthy' | 'resume'

/** A running tool tracked internally: the live row's fields plus what we need
 *  to commit it on completion (the tool name for matching, the call-time diff). */
type RunningTool = ActiveTool & {
	readonly toolName: string
	readonly detail?: readonly string[]
}

/**
 * Every line the finalized transcript will print, for the spacer to measure.
 *
 * Exported so the wiring is testable rather than only typecheckable. The
 * spacer's own docblock states the asymmetry it depends on: over-count the
 * content and the composer merely floats, under-count it and the composer is
 * pushed off the bottom. The caller used to pass each row's `content` alone,
 * which counted a six-line collapsed tool body as nothing at all — the estimate
 * ran low by six per tool call, in the direction that costs the usability
 * rather than the feature. `/expand` makes it acute: a row whose entire
 * substance is a two-hundred-line body would have been handed over as one line.
 *
 * A pending row is excluded because it is not in the static log yet; the
 * spacer's `liveRows` covers the live region.
 */
export function spacerTranscript(messages: readonly TranscriptMessage[]): readonly string[] {
	const finalized = messages.filter((m) => !m.pending)
	return finalized.flatMap((m, i) => [
		// The blank row `MessageRow` puts above every entry but the first and the
		// `⎿` result rows. One row per entry sounds negligible and is not: forty
		// entries is forty rows, which on most terminals is the whole viewport.
		...(i > 0 && m.glyph !== '⎿' ? [''] : []),
		// Indented by the two-column glyph gutter the content renders beside, so
		// a long line is measured against the width it actually has.
		`  ${m.content}`,
		...renderedDetailLines(m),
	])
}


export function App({ ctx }: AppProps) {
	const { exit } = useApp()
	const [messages, setMessages] = useState<readonly TranscriptMessage[]>([])
	const [history, setHistory] = useState<readonly string[]>([])
	const [state, setState] = useState<'idle' | 'thinking' | 'tool' | 'awaiting-permission'>('idle')
	const [phase, setPhase] = useState<LifecyclePhase>('probing')
	const [session, setSession] = useState<AgentSession | null>(null)
	const [detected, setDetected] = useState<readonly DetectedProvider[]>([])
	const [currentProvider, setCurrentProvider] = useState<ProviderId | null>(null)
	const [permission, setPermission] = useState<PermissionRequest | null>(null)
	const [activeSkills, setActiveSkills] = useState<ReadonlyArray<{ name: string; body: string }>>(
		[],
	)
	// Read when the session comes up rather than on every keystroke: the
	// autocomplete dropdown consults this on each character, and a `readdirSync`
	// per keypress is a cost nobody asked for. A file added mid-session is
	// picked up by `/model` (which re-hydrates) or a restart.
	const [userCommands, setUserCommands] = useState<readonly UserCommand[]>([])
	const [usage, setUsage] = useState<{ totalTokens: number; costUsd: number } | null>(null)
	// Context fill, straight from the kernel and held apart from `usage` —
	// they are different quantities and conflating them is what made the
	// gauge climb with turn count instead of with context.
	const [context, setContext] = useState<ContextFill | null>(null)
	// Tools currently executing — rendered live (spinner + elapsed) below the
	// transcript, then committed as static lines on completion.
	const [activeTools, setActiveTools] = useState<readonly ActiveTool[]>([])
	// Bumped to reset the <Static> transcript log (on /clear and /resume).
	const [resetKey, setResetKey] = useState<number>(0)
	// Messages typed while a turn is running — auto-sent when it settles.
	const [queued, setQueued] = useState<readonly string[]>([])
	const [resumeList, setResumeList] = useState<readonly RecentConversation[]>([])
	const [selectedResume, setSelectedResume] = useState<number>(0)
	const exitArmedRef = useRef<boolean>(false)
	const abortRef = useRef<AbortController | null>(null)
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
				threadId: sessions.threadId,
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
					reserved: SLASH_COMMANDS.map((c) => c.name),
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

	const runProbe = useCallback(async () => {
		try {
			const probe = await probeAgentSession()
			setDetected(probe.detected)
			if (probe.needsRepickReason) {
				pushMessage('system', probe.needsRepickReason)
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

	// Blank rows above the composer, while the transcript is short enough that
	// the answer is knowable. `liveRows` is the fixed furniture beneath the
	// transcript — activity line, composer frame, status bar and their padding —
	// counted generously, because over-counting costs a gap and under-counting
	// costs the composer.
	const spacerRows =
		phase === 'ready'
			? bottomSpacerRows({
					rows: process.stdout.rows,
					columns: process.stdout.columns,
					transcript: spacerTranscript(messages),
					liveRows: 10,
				})
			: 0

	const slashCtx: SlashContext = {
		// Called when `/tools` renders, not read here — the same shape, and the
		// same reason, as `neverPrompted` below.
		availableTools: () => session?.toolNames() ?? [],
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
		agentIds: session?.agentIds ?? [],
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

	// Load the chosen conversation into the transcript and continue in it.
	const resumeConversation = useCallback(
		async (conv: RecentConversation) => {
			const sessions = sessionsRef.current
			const scope = scopeRef.current
			setPhase('ready')
			if (!sessions || !scope) return
			try {
				const msgs = await loadConversation(sessions, conv.id)
				const restored: TranscriptMessage[] = msgs
					.filter((m) => m.role === 'user' || m.role === 'assistant')
					.map((m) => ({
						id: nextId(),
						role: m.role as 'user' | 'assistant',
						content: typeof m.content === 'string' ? m.content : '',
					}))
				resetTranscript()
				setMessages(restored)
				scope.sessionId = conv.id // new turns now attribute to the resumed session
				pushMessage('system', `Resumed: ${conv.title}`)
			} catch (err) {
				pushMessage('system', `Could not resume: ${err instanceof Error ? err.message : String(err)}`)
			}
		},
		[nextId, pushMessage],
	)

	// Resolve a pending permission prompt with the user's decision and tear
	// down the overlay. No-op if nothing is pending.
	const resolvePermission = useCallback((decision: PermissionDecision) => {
		const resolve = permissionResolveRef.current
		permissionResolveRef.current = null
		permissionOpenedAtRef.current = null
		setPermission(null)
		if (resolve) resolve(decision)
	}, [])

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
		(event: AgentEvent, st: { assistantId: string | null; text: string }) => {
			const ensureAssistant = () => {
				if (!st.assistantId) st.assistantId = pushMessage('assistant', '', true)
				return st.assistantId
			}
			const closeAssistant = () => {
				if (st.assistantId) {
					finalizeMessage(st.assistantId)
					st.assistantId = null
				}
			}
			switch (event.kind) {
				case 'delta':
					setState('thinking')
					st.text += event.text
					appendToMessage(ensureAssistant(), event.text)
					break
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
					setUsage({ totalTokens: event.totalTokens, costUsd: event.costUsd })
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
					closeAssistant()
					break
				case 'error':
					closeAssistant()
					if (event.message !== 'aborted') pushMessage('system', `Error: ${event.message}`)
					break
			}
		},
		[appendToMessage, finalizeMessage, pushMessage],
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
			const priorForSdk: Message[] = messages
				.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending)
				.map((m) => ({
					role: m.role as 'user' | 'assistant',
					content: m.content,
					timestamp: Date.now(),
				}))
			priorForSdk.push({
				role: 'user',
				content: sendText,
				timestamp: Date.now(),
				...(images && images.length > 0 ? { attachments: images } : {}),
			})

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
			const st = { assistantId: null as string | null, text: '' }
			const ac = new AbortController()
			abortRef.current = ac
			try {
				for await (const event of session.send(priorForSdk, {
					signal: ac.signal,
					// Bypass mode (--dangerously-skip-permissions / --yolo): omit the
					// permission callback so every tool batch auto-approves.
					onPermission: ctx.skipPermissions ? undefined : onPermission,
					extraSystem: composeSkillsPrompt(activeSkills) ?? undefined,
				})) {
					applyEvent(event, st)
				}
			} catch (err) {
				if (st.assistantId) finalizeMessage(st.assistantId)
				pushMessage('system', `Error: ${err instanceof Error ? err.message : String(err)}`)
			} finally {
				abortRef.current = null
				permissionResolveRef.current = null
				permissionOpenedAtRef.current = null
				setPermission(null)
				clearActiveTools()
				setState('idle')
				// Persist the turn to the SDK session store (best-effort) so it can
				// be resumed later. User message + the assistant's reply text.
				const sessions = sessionsRef.current
				const scope = scopeRef.current
				if (sessions && scope) {
					const turn: Message[] = [createUserMessage(text)]
					if (st.text.trim().length > 0) turn.push(createAssistantMessage(st.text))
					void appendMessages(sessions, scope.sessionId, turn).catch(() => {})
				}
			}
		},
		[activeSkills, applyEvent, ctx.cwd, ctx.skipPermissions, finalizeMessage, messages, onPermission, pushMessage, session],
	)

	const handleSubmit = useCallback(
		(value: string, images?: readonly ImageAttachment[]) => {
			setHistory((prev) => [...prev, value])
			// What actually gets sent. A `prompt` action replaces it with text the
			// command composed, and then takes the ordinary send path below —
			// including the queue — so a command-driven turn is not a second way
			// to run one.
			let outgoing = value
			const slash = runSlash(value, slashCtx)
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
						setPhase('picker')
						return
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
			// The disposition, not the key. `credential` never reaches a message.
			pushMessage('system', disposition)
			void hydrateSession(
				{
					version: 3,
					providers: [{ id: credential.entry.id as ProviderId }],
					subagents: { active: [] },
				},
				next,
			)
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
				abortRef.current.abort()
				abortRef.current = null
				setQueued([])
				pushMessage('system', 'Interrupted.')
				return
			}
			// Ctrl+O is deprecated, still bound, and now says so.
			//
			// It was advertised — on every collapsed body — as toggling full
			// expansion for everything, and in that use it did nothing: finalized
			// rows go through `<Static>`, which renders `items.slice(index)` and
			// calls the render function only for items it has not emitted yet, so
			// output already on screen was beyond its reach.
			//
			// It was NOT inert, though, and the difference matters enough to have
			// changed this design. `<Static>` calls the CURRENT render closure for
			// each newly appended item, so pressing the key while a tool was
			// running made that tool's result print in full when it arrived. A
			// working behaviour — undiscoverable, unadvertised, and the opposite of
			// what the hint under the row promised: you had to decide you wanted
			// the output before you had seen that it was truncated.
			//
			// So it is not deleted out from under anyone. It stays bound for a
			// release and answers with the reason and the replacement, which is
			// more than it gave in the case an operator would actually try it.
			if (key.ctrl && input === 'o') {
				pushMessage(
					'system',
					'Ctrl+O is deprecated and no longer expands anything. It could never reopen output already on screen — finalized rows are printed once and never redrawn. Use /expand <n>; the number is in the hint under each collapsed body, and /expand on its own takes the most recent.',
				)
				return
			}
			if (key.ctrl && input === 'c') {
				// A turn is running → first Ctrl+C interrupts it, not exits.
				if (abortRef.current) {
					abortRef.current.abort()
					// Drop the ref now so a second Ctrl+C arms exit instead of
					// re-aborting (which spammed "Interrupted." lines), and clear any
					// queued messages — interrupting means stop, not "run the next one".
					abortRef.current = null
					setQueued([])
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
					/>
				) : (
					<>
						<TranscriptFrame>
							<Transcript
								messages={messages.filter((m) => !m.pending)}
								pending={messages.find((m) => m.pending) ?? null}
								state={state}
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
								disabled={phase !== 'ready' || state === 'awaiting-permission'}
								hidden={permission !== null}
								// A turn is running, so Esc is the interrupt and not
								// the composer's clear.
								escapeInterrupts={state === 'thinking' || state === 'tool'}
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
						hint={hintForPhase(phase, state, session?.hasProvider === true)}
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
