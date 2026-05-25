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
import { useCallback, useEffect, useRef, useState } from 'react'

import {
	type DetectedProvider,
	type Preferences,
	type ProviderId,
	writePreferences,
} from '../integrations/providers/index.js'
import { isTrusted, trustDir } from '../integrations/trust/store.js'
import { appendMemory, composeMemoryPrompt, readMemory } from '../memory/store.js'
import { composeSkillsPrompt, discoverSkills, loadSkillBody } from '../skills/store.js'
import { type ActiveTool, LiveActivity, formatElapsed } from './LiveActivity.js'
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
import { StatusBar } from './StatusBar.js'
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
	type AgentSession,
	type PermissionDecision,
	type PermissionRequest,
	type RunScope,
	createAgentSession,
	probeAgentSession,
} from './agent.js'
import { ResumePicker } from './ResumePicker.js'
import { type SlashContext, runSlash } from './slashCommands.js'
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
	const [usage, setUsage] = useState<{ totalTokens: number; costUsd: number } | null>(null)
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
			const s = await createAgentSession(prefs, detectedNow, scope)
			setSession(s)
			setCurrentProvider(prefs.provider)
			if (s.hasProvider) {
				setPhase('ready')
				pushMessage(
					'system',
					`Connected to ${s.providerSummary}${s.modelSummary ? ` · ${s.modelSummary}` : ''} · ${s.toolNames.length} tools${s.deferredToolCount > 0 ? ` (+${s.deferredToolCount} on demand)` : ''}`,
				)
			} else {
				setPhase('unhealthy')
				if (s.errorHint) pushMessage('system', s.errorHint)
			}
		},
		[pushMessage],
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

	const slashCtx: SlashContext = {
		availableTools: session?.toolNames ?? [],
		providerSummary: session?.providerSummary ?? null,
		modelSummary: session?.modelSummary ?? null,
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
			// The model interleaves text → tool → text across iterations.
			// Track the current assistant bubble and finalize it at each tool
			// boundary so later text renders below the tool line, in order.
			let assistantId: string | null = null
			const ensureAssistant = () => {
				if (!assistantId) assistantId = pushMessage('assistant', '', true)
				return assistantId
			}
			const closeAssistant = () => {
				if (assistantId) {
					finalizeMessage(assistantId)
					assistantId = null
				}
			}
			const ac = new AbortController()
			abortRef.current = ac
			let assistantText = ''
			try {
				for await (const event of session.send(priorForSdk, {
					signal: ac.signal,
					// Bypass mode (--dangerously-skip-permissions / --yolo): omit the
					// permission callback so every tool batch auto-approves.
					onPermission: ctx.skipPermissions ? undefined : onPermission,
					extraSystem: composeSkillsPrompt(activeSkills) ?? undefined,
				})) {
					switch (event.kind) {
						case 'delta':
							setState('thinking')
							assistantText += event.text
							appendToMessage(ensureAssistant(), event.text)
							break
						case 'tool-start': {
							closeAssistant()
							setState('tool')
							// Don't print the call line yet — show it live (spinner +
							// ticking timer) until it completes, then commit it.
							const tool: RunningTool = {
								id: nextId(),
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
							// Match the oldest running tool of this name (FIFO), commit it
							// as a static line with a ✓/✗ status glyph + elapsed time.
							const running = activeToolsRef.current
							let i = running.findIndex((t) => t.toolName === event.toolName)
							if (i < 0) i = running.length > 0 ? 0 : -1
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
							break
						case 'task':
							pushMessage('tool', event.subject, false, event.status === 'completed' ? '☑' : '☐')
							break
						case 'done':
							closeAssistant()
							break
						case 'error':
							closeAssistant()
							// 'aborted' is a user interrupt — the "Interrupted." line already
							// covers it; don't add a redundant "Error: aborted".
							if (event.message !== 'aborted') {
								pushMessage('system', `Error: ${event.message}`)
							}
							break
					}
				}
			} catch (err) {
				closeAssistant()
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
					if (assistantText.trim().length > 0) turn.push(createAssistantMessage(assistantText))
					void appendMessages(sessions, scope.sessionId, turn).catch(() => {})
				}
			}
		},
		[activeSkills, appendToMessage, ctx.cwd, ctx.skipPermissions, finalizeMessage, messages, onPermission, pushMessage, session],
	)

	const handleSubmit = useCallback(
		(value: string, images?: readonly ImageAttachment[]) => {
			setHistory((prev) => [...prev, value])
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
						const skills = discoverSkills()
						if (skills.length === 0) {
							pushMessage(
								'system',
								'No skills found. Add one at ~/.namzu/skills/<name>/SKILL.md or ./skills/<name>/SKILL.md.',
							)
							return
						}
						const activeNames = new Set(activeSkills.map((s) => s.name))
						const lines = skills.map(
							(s) => `${activeNames.has(s.name) ? '● ' : '○ '}${s.name} — ${s.description}`,
						)
						pushMessage('system', `Skills (● active):\n  ${lines.join('\n  ')}`)
						return
					}
					case 'load-skill': {
						const info = discoverSkills().find((s) => s.name === slash.name)
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
					case 'none':
						return
				}
			}
			// A turn is in flight → queue the message; it auto-sends when idle.
			// (Queued messages are text-only; pasted images aren't carried.)
			if (state !== 'idle') {
				setQueued((q) => [...q, value])
				return
			}
			void runTurn(value, images)
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

	const handlePickerSubmit = useCallback(
		(selection: { provider: string; model?: string }) => {
			const prefs: Preferences = {
				version: 2,
				provider: selection.provider as ProviderId,
				model: selection.model,
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
	// (like claude-code / gemini-cli) and only theme the foreground. Forcing
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
						onSubmit={handlePickerSubmit}
						onCancel={handlePickerCancel}
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
						contextWindow={contextWindowFor(session?.modelSummary ?? null)}
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

/** Approximate context window (tokens) per model, for the status gauge. The
 *  `[1m]` long-context variants get 1M; everything else defaults to 200k. */
function contextWindowFor(model: string | null): number {
	if (!model) return 200_000
	if (model.includes('[1m]') || model.includes('-1m')) return 1_000_000
	return 200_000
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

// Claude-Code-style tool call label: `Bash(ls -la)`, `Read(file.ts)`.
// The `clawtool_` prefix is stripped and the name title-cased.
function formatToolCall(toolName: string, summary: string): string {
	const base = toolName.replace(/^clawtool_/, '')
	const display = base.length > 0 ? base[0]?.toUpperCase() + base.slice(1) : base
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
