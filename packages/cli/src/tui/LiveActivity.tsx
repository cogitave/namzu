/**
 * The live region rendered just below the (static) transcript: the tool(s)
 * currently executing, with elapsed time and progress, or a "thinking" line
 * before the first token of a reply. A green fill through the Working label marks the
 * active turn. These rows stay tiny to keep per-frame cost bounded.
 */

import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'

import { motionAllowed, useReducedMotion } from './motion.js'
import { type ProviderWaitNotice, describeProviderWaitClock } from './plain-interruption.js'
import { shellRunningRows, shellToneColor } from './shell-cell.js'
import { blendTowardStall, easeStall, stallTarget } from './stall-colour.js'
import { RESULT_GUTTER_INDENT, RESULT_GUTTER_WIDTH } from './system-rows.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'
import { formatCompactCount, formatElapsed } from './units.js'
import type { WebActivity } from './web-activity.js'

export interface ActiveTool {
	readonly id: string
	/** Display label, e.g. `Bash(npm test)`. */
	readonly label: string
	readonly startedAt: number
	/** Latest bounded progress state; intermediate updates are intentionally coalesced. */
	readonly progress?: string
	readonly fraction?: number
	/**
	 * Set when this call is a `wait_for_task` on a delegated agent the monitor
	 * knows: that agent's description. When every running call is such a
	 * wait, the rows fold into one `✻ Waiting for …` line.
	 */
	readonly waitingOn?: string
	/** A web search or fetch: its `progress` line is drawn as the call's `⎿` status. */
	readonly web?: WebActivity
	/** A shell call's command; set, the call is drawn as a command cell (`● Bash(…)` over `⎿ Running…`). */
	readonly command?: string
	/** The last few output lines the shell call has reported, oldest first. */
	readonly tail?: readonly string[]
	/** Asked about or waiting behind another question: drawn quiet, with a static dim dot. */
	readonly queued?: true
}

export interface LiveActivityProps {
	/** Show the current tool and total count in two rows on a short terminal. */
	readonly compact?: boolean
	readonly activeTools: readonly ActiveTool[]
	/** The parent turn is active, including while answer text is streaming. */
	readonly working: boolean
	/** Actual child sessions retained by the current conversation. */
	readonly agentCount?: number
	/** A compaction is running: the figures group shows, and the stall tint stays off. */
	readonly compacting?: boolean
	/** False for non-interactive renderers and deterministic snapshots. */
	readonly animate?: boolean
	/**
	 * The model's current line of reasoning, or `null`. Shown dim under the
	 * Working row and nowhere else; an empty string means "thinking, but the
	 * provider gave no readable text" and still earns the row.
	 */
	readonly thinking?: string | null
	/**
	 * Output tokens this turn has produced so far, as `↓ 1.1k tokens`. The
	 * provider's own count once it has reported one, plus an estimate of what
	 * has streamed since. Absent or zero draws nothing.
	 */
	readonly tokens?: number
	/**
	 * A question for the operator is on screen (a confirmation, a Continue
	 * card, a permission review): the row says so instead of counting, and the
	 * time spent waiting is left out of the turn's elapsed time. A timer that
	 * kept running under "Continue the scheduled run?" read as work being done.
	 */
	readonly waitingForYou?: boolean
	/**
	 * Why the reply is quiet while the provider is being asked again: one row
	 * under Working, the failure in the error colour and a dim
	 * `Retrying in 5s · attempt 2/10` that counts down.
	 */
	readonly waitNotice?: ProviderWaitNotice | null
	/**
	 * What the row says in place of `Working`, for a stretch that is not a reply
	 * (`Compacting conversation…`). The spinner and the clock stay.
	 */
	readonly activityLabel?: string
	/**
	 * A dim `Tip:` line under the working row. Hidden while a retry notice or a
	 * compaction is on the row, when the plan's `nextTask` line shows instead,
	 * and in the compact layout, which has no room for it.
	 */
	readonly tip?: string
	/** The plan's next task, as the whole `Next: …` line. Wins over `tip`. */
	readonly nextTask?: string
}

/** Redraws once a second while a retry is being waited out, so its countdown moves. */
function useSecondTick(active: boolean): void {
	const [, setTick] = useState(0)
	useEffect(() => {
		if (!active) return
		const timer = setInterval(() => setTick((n) => n + 1), 1000)
		return () => clearInterval(timer)
	}, [active])
}

const MAX_VISIBLE_TOOLS = 3

/** The figures in parentheses stay hidden until there is something to say, or the wait gets long. */
const FIGURES_AFTER_MS = 16_000

export function LiveActivity({
	compact = false,
	activeTools,
	working,
	agentCount = 0,
	compacting = false,
	animate = true,
	thinking = null,
	tokens,
	waitingForYou = false,
	waitNotice = null,
	activityLabel,
	tip,
	nextTask,
}: LiveActivityProps) {
	const { stdout } = useStdout()
	const screenReader = useIsScreenReaderEnabled()
	useReducedMotion()
	const motion = animate && stdout.isTTY === true && !screenReader && motionAllowed()
	const active = activeTools.length > 0 || working
	const startedAtRef = useRef<number | null>(null)
	// Time spent waiting on the operator, left out of the elapsed figure.
	const pausedRef = useRef<{ total: number; since: number | null }>({ total: 0, since: null })
	if (active && startedAtRef.current === null) {
		startedAtRef.current = Date.now()
		pausedRef.current = { total: 0, since: null }
	}
	if (!active) startedAtRef.current = null
	if (waitingForYou && pausedRef.current.since === null) pausedRef.current.since = Date.now()
	const resumedFromWait = !waitingForYou && pausedRef.current.since !== null
	if (resumedFromWait && pausedRef.current.since !== null) {
		pausedRef.current.total += Date.now() - pausedRef.current.since
		pausedRef.current.since = null
	}
	useSecondTick(waitNotice?.retryAt !== undefined)
	// The last moment the reply made progress: a token count or a reasoning line that moved.
	const progressRef = useRef<{ key: string; at: number; stall: number; eased: number }>({
		key: '',
		at: Date.now(),
		stall: 0,
		eased: Date.now(),
	})
	const progressKey = `${tokens ?? 0}|${thinking ?? ''}`
	if (!active) progressRef.current = { key: '', at: Date.now(), stall: 0, eased: Date.now() }
	else if (progressRef.current.key !== progressKey)
		progressRef.current = { key: progressKey, at: Date.now(), stall: 0, eased: Date.now() }
	// Waiting on the person is not the model being slow: count again from their answer.
	else if (waitingForYou || resumedFromWait) progressRef.current.at = Date.now()
	const { frame: tick } = useAnimation({
		isActive: active && motion && !waitingForYou,
		interval: 120,
	})
	if (!active) return null
	if (waitingForYou) {
		// Calls waiting for a yes keep their quiet rows above the question, so a
		// person sees what each answer is for.
		const queued = activeTools.filter((tool) => tool.queued === true)
		const shownQueued = queued.slice(0, MAX_VISIBLE_TOOLS)
		return (
			<Box flexDirection="column" marginTop={1}>
				<Box>
					<Text color={theme.text.secondary}>Waiting for you</Text>
					<Text color={theme.text.muted}> · the question below</Text>
				</Box>
				{shownQueued.map((tool) => (
					<QueuedToolRow key={tool.id} tool={tool} />
				))}
				{queued.length > shownQueued.length ? (
					<Box paddingLeft={2}>
						<Text color={theme.text.muted}>+{queued.length - shownQueued.length} more waiting</Text>
					</Box>
				) : null}
			</Box>
		)
	}
	const now = Date.now()
	const elapsedMs = now - (startedAtRef.current ?? now) - pausedRef.current.total
	const elapsed = formatElapsed(elapsedMs)
	// The stall tint: eased toward its target, and never while the wait is not the model's.
	const progress = progressRef.current
	const stallExempt = activeTools.length > 0 || thinking !== null || compacting
	// A tool, reasoning or a compaction is not silence: measure the gap from when it ends.
	if (stallExempt) progress.at = now
	progress.stall = easeStall(
		progress.stall,
		stallTarget({ sinceLastTokenMs: now - progress.at, exempt: stallExempt }),
		now - progress.eased,
	)
	progress.eased = now
	const tint = motion && progress.stall > 0 ? progress.stall : 0
	// A palette limited to named colours has no rgb to blend from, so it never tints.
	const labelColor = (rgb: readonly [number, number, number] | undefined, plain: string): string =>
		tint > 0 && rgb ? blendTowardStall(rgb, tint) : plain
	const label = activityLabel ?? 'Working'
	const edge = tick % (label.length + 1)
	const mark = (
		<Text>
			{Array.from(label, (char, column) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own and hold no state, so the index is the key.
					key={column}
					color={
						!motion
							? theme.text.secondary
							: column < edge
								? labelColor(theme.live.rgb?.done, theme.live.done)
								: column === edge
									? labelColor(theme.live.rgb?.edge, theme.live.edge)
									: labelColor(theme.live.rgb?.ahead, theme.live.ahead)
					}
				>
					{char}
				</Text>
			))}
		</Text>
	)
	const spent =
		tokens !== undefined && tokens > 0 ? ` · ↓ ${formatCompactCount(tokens)} tokens` : ''
	const waiting = waitingLine(activeTools)
	const hasFigures =
		(tokens !== undefined && tokens > 0) ||
		thinking !== null ||
		compacting ||
		agentCount > 0 ||
		elapsedMs > FIGURES_AFTER_MS
	const figures = hasFigures
		? `${elapsed}${spent}${
				agentCount > 0
					? ` · ${agentCount} agent${agentCount === 1 ? '' : 's'} · ctrl+t to view`
					: ''
			}`
		: ''
	const visibleTools = waiting ? [] : activeTools.slice(0, MAX_VISIBLE_TOOLS)
	const hiddenTools = waiting ? 0 : activeTools.length - visibleTools.length
	const noticeRow = waitNotice ? (
		<Box paddingLeft={2}>
			<Text wrap="truncate-end">
				<Text color={waitNotice.retryAt === undefined ? theme.text.muted : theme.status.error}>
					● {terminalDisplayText(waitNotice.what)}
				</Text>
				{waitNotice.retryAt === undefined ? null : (
					<Text color={theme.text.muted}> · {describeProviderWaitClock(waitNotice, now)}</Text>
				)}
			</Text>
		</Box>
	) : null
	const waitingRow = waiting ? (
		<Box paddingLeft={2}>
			<Text color={theme.text.secondary} wrap="truncate-end">
				✻ {terminalDisplayText(waiting)}
			</Text>
		</Box>
	) : null

	const hintLine =
		compacting || waitNotice ? undefined : (nextTask ?? (tip ? `Tip: ${tip}` : undefined))
	const hintRow =
		hintLine === undefined ? null : (
			<Box paddingLeft={2}>
				<Text color={theme.text.muted} wrap={nextTask ? 'truncate-end' : 'wrap'}>
					{terminalDisplayText(hintLine)}
				</Text>
			</Box>
		)

	if (compact) {
		const current = activeTools[0]
		return (
			<Box flexDirection="column" marginTop={1}>
				<Box>
					{mark}
					{(() => {
						const parts = [
							...(hasFigures ? [`${elapsed}${spent}`] : []),
							...(activeTools.length > 0
								? [`${activeTools.length} tool${activeTools.length === 1 ? '' : 's'}`]
								: []),
						]
						return parts.length > 0 ? (
							<Text color={theme.text.muted}>{` · ${parts.join(' · ')}`}</Text>
						) : null
					})()}
				</Box>
				{noticeRow ??
					(waitingRow ? (
						waitingRow
					) : current ? (
						<Box paddingLeft={2}>
							<Text color={theme.text.secondary} wrap="truncate-end">
								{terminalDisplayText(current.label)}
								{current.progress ? (
									<Text color={theme.text.muted}> · {terminalDisplayText(current.progress)}</Text>
								) : null}
							</Text>
						</Box>
					) : thinking !== null ? (
						<Box paddingLeft={2}>
							<Text color={theme.text.muted} wrap="truncate-end">
								thinking{thinking ? ` · ${terminalDisplayText(thinking)}` : '…'}
							</Text>
						</Box>
					) : null)}
			</Box>
		)
	}

	return (
		<Box flexDirection="column" marginTop={1}>
			<Box flexDirection="row">
				{/* The label keeps its letters on a narrow terminal; the figures after
				    it are what gets cut, with an ellipsis. */}
				<Box flexShrink={0}>{mark}</Box>
				{hasFigures ? (
					<Text color={theme.text.muted} wrap="truncate-end">
						{` (${figures})`}
					</Text>
				) : null}
			</Box>
			{hintRow}
			{waitingRow}
			{noticeRow}
			{visibleTools.map((t, index) => {
				if (t.command !== undefined && !t.queued) {
					// A shell call reads like its settled row: a dim dot that blinks while
					// it runs, and `⎿ Running… (12s)` until it prints something.
					const blink = motion ? Math.floor(tick / 5) % 2 === 0 : true
					const rows = shellRunningRows(t.tail ?? [], formatElapsed(now - t.startedAt))
					return (
						<Box key={t.id} flexDirection="column">
							<Box flexDirection="row">
								<Box width={2} flexShrink={0}>
									<Text color={theme.text.muted}>{blink ? '●' : ' '}</Text>
								</Box>
								<Text color={theme.text.secondary} wrap="truncate-end">
									{terminalDisplayText(t.label)}
								</Text>
							</Box>
							<Box flexDirection="column" paddingLeft={RESULT_GUTTER_INDENT}>
								{rows.map((row, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: these rows hold no state of their own.
									<Box key={`r-${i}`} flexDirection="row">
										<Box width={RESULT_GUTTER_WIDTH} flexShrink={0}>
											<Text color={theme.text.muted}>{i === 0 ? '⎿' : ' '}</Text>
										</Box>
										<Text color={shellToneColor(row.tone)} wrap="truncate-end">
											{terminalDisplayText(row.text)}
										</Text>
									</Box>
								))}
							</Box>
						</Box>
					)
				}
				if (t.queued) return <QueuedToolRow key={t.id} tool={t} />
				const percent = t.fraction === undefined ? '' : `${Math.round(t.fraction * 100)}% · `
				return (
					<Box key={t.id} flexDirection="column" paddingLeft={2}>
						<Box flexDirection="row">
							<Box width={2} flexShrink={0}>
								<Text color={theme.text.muted}>
									{index === visibleTools.length - 1 && hiddenTools === 0 ? '└' : '├'}
								</Text>
							</Box>
							<Text color={theme.text.secondary} wrap="truncate-end">
								{terminalDisplayText(t.label)}
								<Text color={theme.text.muted}> · {formatElapsed(now - t.startedAt)}</Text>
							</Text>
						</Box>
						{t.progress !== undefined ? (
							<Box flexDirection="row" paddingLeft={2}>
								<Text color={theme.text.muted} wrap="truncate-end">
									{t.web ? '⎿ ' : ''}
									{percent}
									{terminalDisplayText(t.progress)}
								</Text>
							</Box>
						) : null}
					</Box>
				)
			})}
			{hiddenTools > 0 ? (
				<Box paddingLeft={2}>
					<Text color={theme.text.muted}>└ +{hiddenTools} more tools</Text>
				</Box>
			) : null}
			{thinking !== null && activeTools.length === 0 ? (
				<Box paddingLeft={2}>
					<Text color={theme.text.muted} wrap="truncate-end">
						└ thinking{thinking.length > 0 ? ` · ${terminalDisplayText(thinking)}` : '…'}
					</Text>
				</Box>
			) : null}
		</Box>
	)
}

/**
 * A call that has not been given its yes: a static dim dot and the call's own
 * title, and for a shell call a dim `Waiting…` where `Running…` will go.
 */
function QueuedToolRow({ tool }: { readonly tool: ActiveTool }) {
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Box width={2} flexShrink={0}>
					<Text color={theme.text.muted}>●</Text>
				</Box>
				<Text color={theme.text.secondary} wrap="truncate-end">
					{terminalDisplayText(tool.label)}
				</Text>
			</Box>
			{tool.command !== undefined ? (
				<Box paddingLeft={RESULT_GUTTER_INDENT}>
					<Box width={RESULT_GUTTER_WIDTH} flexShrink={0}>
						<Text color={theme.text.muted}>⎿</Text>
					</Box>
					<Text color={shellToneColor('dim')}>Waiting…</Text>
				</Box>
			) : null}
		</Box>
	)
}

/**
 * One line for a turn that is only waiting on its delegated agents, or
 * `undefined` when any running call is something else — a wait mixed with
 * real work keeps every row, so the work is never hidden behind the wait.
 */
export function waitingLine(tools: readonly ActiveTool[]): string | undefined {
	if (tools.length === 0 || !tools.every((tool) => tool.waitingOn !== undefined)) return undefined
	const names = [...new Set(tools.map((tool) => tool.waitingOn as string))]
	return names.length === 1
		? `Waiting for ${names[0]}`
		: `Waiting for ${names.length} agents to finish`
}

export { formatElapsed } from './units.js'
