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

import type { Message } from '@namzu/sdk'
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
import { Composer } from './Composer.js'
import { TrustPrompt } from './TrustPrompt.js'
import {
	NAMZU_ICON,
	NAMZU_ICON_GRADIENT,
	NAMZU_LOGO_MIN_WIDTH,
	NAMZU_MARK,
	NAMZU_MARK_COLOR,
} from './logo.js'
import { PermissionOverlay } from './PermissionOverlay.js'
import { Picker } from './Picker.js'
import { StatusBar } from './StatusBar.js'
import { Transcript } from './Transcript.js'
import {
	type AgentSession,
	type PermissionDecision,
	type PermissionRequest,
	createAgentSession,
	probeAgentSession,
} from './agent.js'
import { type SlashContext, runSlash } from './slashCommands.js'
import { theme } from './theme.js'
import type { TranscriptMessage, TuiContext } from './types.js'

export interface AppProps {
	readonly ctx: TuiContext
}

type LifecyclePhase = 'trust' | 'probing' | 'picker' | 'ready' | 'unhealthy'

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
	const [expanded, setExpanded] = useState<boolean>(false)
	// Messages typed while a turn is running — auto-sent when it settles.
	const [queued, setQueued] = useState<readonly string[]>([])
	const exitArmedRef = useRef<boolean>(false)
	const abortRef = useRef<AbortController | null>(null)
	const permissionResolveRef = useRef<((d: PermissionDecision) => void) | null>(null)
	const idRef = useRef<number>(0)
	const nextId = useCallback(() => {
		idRef.current += 1
		return `m${idRef.current}`
	}, [])

	const pushMessage = useCallback(
		(
			role: TranscriptMessage['role'],
			content: string,
			pending = false,
			glyph?: string,
			detail?: readonly string[],
		) => {
			const id = nextId()
			setMessages((prev) => [...prev, { id, role, content, pending, glyph, detail }])
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

	const hydrateSession = useCallback(
		async (prefs: Preferences, detectedNow: readonly DetectedProvider[]) => {
			const s = await createAgentSession(prefs, detectedNow)
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
		async (text: string) => {
			if (!session || !session.hasProvider) {
				pushMessage('system', session?.errorHint ?? 'Agent is not ready yet — give it a moment.')
				return
			}
			const priorForSdk: Message[] = messages
				.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending)
				.map((m) => ({
					role: m.role as 'user' | 'assistant',
					content: m.content,
					timestamp: Date.now(),
				}))
			priorForSdk.push({ role: 'user', content: text, timestamp: Date.now() })

			pushMessage('user', text)
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
							appendToMessage(ensureAssistant(), event.text)
							break
						case 'tool-start':
							closeAssistant()
							setState('tool')
							pushMessage(
								'tool',
								formatToolCall(event.toolName, event.summary),
								false,
								'⏺',
								event.detail,
							)
							break
						case 'tool-end':
							if (event.isError || event.summary.length > 0 || (event.detail?.length ?? 0) > 0) {
								pushMessage(
									'tool',
									event.isError ? `failed: ${event.summary}` : event.summary,
									false,
									'⎿',
									event.detail,
								)
							}
							setState('thinking')
							break
						case 'usage':
							setUsage({ totalTokens: event.totalTokens, costUsd: event.costUsd })
							break
						case 'done':
							closeAssistant()
							break
						case 'error':
							closeAssistant()
							pushMessage('system', `Error: ${event.message}`)
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
				setState('idle')
			}
		},
		[activeSkills, appendToMessage, finalizeMessage, messages, onPermission, pushMessage, session],
	)

	const handleSubmit = useCallback(
		(value: string) => {
			setHistory((prev) => [...prev, value])
			const slash = runSlash(value, slashCtx)
			if (slash) {
				switch (slash.kind) {
					case 'message':
						pushMessage(slash.role, slash.content)
						return
					case 'clear':
						setMessages([])
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
					case 'none':
						return
				}
			}
			// A turn is in flight → queue the message; it auto-sends when idle.
			if (state !== 'idle') {
				setQueued((q) => [...q, value])
				return
			}
			void runTurn(value)
		},
		[activeSkills, exit, pushMessage, runTurn, slashCtx, state],
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
			// Ctrl+O toggles expansion of collapsed tool diffs / output.
			if (key.ctrl && input === 'o') {
				setExpanded((e) => !e)
				return
			}
			if (key.ctrl && (input === 'c' || input === '\x03')) {
				// A turn is running → first Ctrl+C interrupts it, not exits.
				if (abortRef.current) {
					abortRef.current.abort()
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
			<Banner
				version={ctx.version}
				session={session}
				bypass={ctx.skipPermissions === true}
				cwd={ctx.cwd}
			/>
			<Box flexDirection="column" paddingX={1}>
				{phase === 'trust' ? (
					<TrustPrompt cwd={ctx.cwd} />
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
							<Transcript messages={messages} state={state} expanded={expanded} />
						</TranscriptFrame>
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
	const wide = cols >= NAMZU_LOGO_MIN_WIDTH
	const provider = session?.providerSummary
	const model = session?.modelSummary
	const home = process.env.HOME
	const prettyCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
	return (
		<Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
			<Box flexDirection="row">
				{wide ? (
					<Box flexDirection="column" marginRight={2}>
						{NAMZU_ICON.map((line, i) => (
							<Text key={`icon-${i}`} color={NAMZU_ICON_GRADIENT[i]}>
								{line}
							</Text>
						))}
					</Box>
				) : (
					<Text color={NAMZU_MARK_COLOR}>{NAMZU_MARK} </Text>
				)}
				<Box flexDirection="column">
					<Text>
						<Text color={NAMZU_MARK_COLOR} bold>
							namzu
						</Text>
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
	if (phase === 'probing') return 'discovering providers…'
	if (phase === 'picker') return '↑↓ navigate · enter accept · esc cancel'
	if (phase === 'unhealthy') return 'Ctrl+C ×2 to exit'
	if (state === 'awaiting-permission') return 'y approve · n reject · a approve all'
	if (state !== 'idle') return 'agent is working — Ctrl+C to interrupt'
	return '/help · /model · /quit · Ctrl+C ×2 to exit'
}
