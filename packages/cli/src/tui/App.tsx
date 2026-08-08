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
import { Picker } from './Picker.js'
import { type ContextFill, StatusBar } from './StatusBar.js'
import { Transcript } from './Transcript.js'
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
	const [expanded, setExpanded] = useState<boolean>(false)
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
				{ id, role, content, pending, glyph, detail, glyphColor, meta },
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
					`Connected to ${s.providerSummary}${s.modelSummary ? ` · ${s.modelSummary}` : ''} · ${s.toolNames.length} tools`,
				)
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
					transcript: messages.filter((m) => !m.pending).map((m) => m.content),
					liveRows: 10,
				})
			: 0

	const slashCtx: SlashContext = {
		availableTools: session?.toolNames ?? [],
		providerSummary: session?.providerSummary ?? null,
		modelSummary: session?.modelSummary ?? null,
		// The same state the status bar reads, unformatted. `/cost` prints exact
		// figures where the bar abbreviates to fit.
		usage,
		permissions: {
			skipPermissions: ctx.skipPermissions === true,
			rules: ctx.rules ?? [],
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
		setPermission(null)
		if (resolve) resolve(decision)
	}, [])

	// Bridge passed into session.send(): the agent calls this before a
	// non-read-only tool batch; it parks until the user presses y/n/a.
	const onPermission = useCallback(
		(req: PermissionRequest) =>
			new Promise<PermissionDecision>((resolve) => {
				permissionResolveRef.current = resolve
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
					case 'prompt':
						// Deliberately does NOT return: the composed text falls
						// through to the same queue-or-send below that a typed
						// message takes.
						outgoing = slash.text
						break
					case 'none':
						return
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
		[activeSkills, doResume, exit, pushMessage, runTurn, slashCtx, state],
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

	const handlePickerCancel = useCallback(() => {
		setPhase('unhealthy')
		pushMessage(
			'system',
			'Picker cancelled. Set an LLM credential (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / start Ollama) and restart namzu.',
		)
	}, [pushMessage])

	useInput(
		(input, key) => {
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
				if (ch === 'y' || key.return) acceptTrust()
				else if (ch === 'n' || key.escape || (key.ctrl && input === 'c')) exit()
				return
			}
			// A pending permission prompt owns the keyboard: y/n/a decide it.
			if (permissionResolveRef.current) {
				const ch = input.toLowerCase()
				if (key.ctrl && (input === 'c' || input === '\x03')) {
					resolvePermission({ kind: 'reject', feedback: 'User interrupted.' })
					abortRef.current?.abort()
					return
				}
				if (ch === 'y' || key.return) resolvePermission({ kind: 'approve' })
				else if (ch === 'a') resolvePermission({ kind: 'approve-all' })
				else if (ch === 'n' || key.escape) resolvePermission({ kind: 'reject' })
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
			// Ctrl+O toggles expansion of collapsed tool diffs / output.
			if (key.ctrl && input === 'o') {
				setExpanded((e) => !e)
				return
			}
			if (key.ctrl && (input === 'c' || input === '\x03')) {
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
		{ isActive: phase !== 'picker' },
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
								expanded={expanded}
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
						{permission ? (
							<PermissionOverlay toolCalls={permission.toolCalls} />
						) : (
							<ComposerFrame focus={state === 'idle' && phase === 'ready'}>
								{queued.length > 0 ? (
									<Box paddingX={1}>
										<Text color={theme.text.muted}>
											⏎ {queued.length} message{queued.length > 1 ? 's' : ''} queued — sending when
											ready
										</Text>
									</Box>
								) : null}
								<Composer
									disabled={phase !== 'ready' || state === 'awaiting-permission'}
									onSubmit={handleSubmit}
									userCommands={userCommands}
									history={history}
								/>
							</ComposerFrame>
						)}
					</>
				)}
				<Box paddingTop={1}>
					<StatusBar
						cwd={ctx.cwd}
						provider={session?.providerSummary ?? null}
						model={session?.modelSummary ?? null}
						state={state}
						hint={hintForPhase(phase, state)}
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
	children,
}: {
	readonly focus: boolean
	readonly children: React.ReactNode
}) {
	// Input-field look: a rounded rule above and below the composer, no side
	// borders, so the input reads as a field rather than a heavy box.
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderTop={true}
			borderBottom={true}
			borderLeft={false}
			borderRight={false}
			borderColor={focus ? theme.border.focus : theme.border.default}
			marginTop={1}
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
): string {
	if (phase === 'trust') return 'y trust this folder · n exit'
	if (phase === 'resume') return '↑↓ navigate · enter resume · esc cancel'
	if (phase === 'probing') return 'discovering providers…'
	if (phase === 'picker') return '↑↓ navigate · enter accept · esc cancel'
	if (phase === 'unhealthy') return 'Ctrl+C ×2 to exit'
	if (state === 'awaiting-permission') return 'y approve · n reject · a approve all'
	if (state !== 'idle') return 'agent is working — esc to interrupt'
	return '/help · @file / Ctrl+V to attach · Ctrl+C ×2 to exit'
}
