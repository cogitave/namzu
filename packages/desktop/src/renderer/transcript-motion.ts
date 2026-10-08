import { type RefObject, useLayoutEffect, useRef } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import { latestPlanTurn } from './plan-row.js'
import { elapsedLabel, transcriptOutcome, turnDurationMs } from './transcript-layout.js'

export const transcriptMotion = {
	entry: { duration: 120, easing: 'ease-out' },
	phase: { duration: 120, easing: 'ease-out' },
	frame: { duration: 260, easing: 'cubic-bezier(0.42, 0, 0.58, 1)' },
} as const

export function transcriptEntryKey(entry: TimelineEntry): string {
	return entry.kind === 'message' ? `message-${entry.index}` : `${entry.kind}-${entry.id}`
}

export function livePhaseLabel(thread: ThreadState): string | undefined {
	const phase = threadPhase(thread)
	if (phase === 'idle') return undefined
	return phase === 'waiting'
		? 'Waiting for your decision'
		: phase === 'thinking'
			? 'Thinking'
			: 'Working'
}

export interface LiveStage {
	text: string
	/** Where the words came from; only `waiting` holds still instead of shimmering. */
	source: 'waiting' | 'reasoning' | 'gap'
}

/** What the live block's bottom line says, and which row it replaces. */
export interface LiveStatus {
	/** Undefined when the block already shows the live element itself. */
	stage?: LiveStage
	/** The reasoning row the status line stands in for; not drawn while it is the newest entry. */
	hiddenReasoningId?: string
}

const stageMax = 80

/** Plain words: the markdown a model writes in a headline never reaches the status line. */
function stripMarkdown(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '')
		.replace(/[*_`~]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

/** Cut at a word boundary, with an ellipsis, so the line never wraps or reads half a word. */
export function clipStage(text: string, max = stageMax): string {
	if (text.length <= max) return text
	const cut = text.slice(0, max - 1)
	const space = cut.lastIndexOf(' ')
	return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}

/**
 * The stage a model stated in `text`: a leading bold run, else the first sentence. Undefined while it
 * is still being written, so a half-streamed headline never reaches the screen.
 */
export function statedStage(text: string, finished: boolean): string | undefined {
	const trimmed = text.trimStart()
	if (!trimmed) return undefined
	const bold = /^\*\*([\s\S]+?)\*\*/.exec(trimmed)
	if (bold) {
		const headline = stripMarkdown(bold[1] ?? '')
		return headline ? clipStage(headline) : undefined
	}
	// An opening bold run with no close yet is still being written.
	if (trimmed.startsWith('**') && !finished) return undefined
	const end = /[.!?…](?=\s|$)|\n/.exec(trimmed)
	if (!end && !finished) return undefined
	const sentence = stripMarkdown(
		end ? trimmed.slice(0, end.index + (end[0] === '\n' ? 0 : 1)) : trimmed,
	)
	return sentence ? clipStage(sentence) : undefined
}

/** The entries a person can see in this turn, in order. */
function drawnEntries(thread: ThreadState): TimelineEntry[] {
	return thread.timeline.filter((entry) => {
		if (entry.turn !== thread.turn) return false
		if (entry.kind === 'tool') return Boolean(thread.tools[entry.id])
		if (entry.kind === 'reasoning') return Boolean(thread.reasoning[entry.id]?.text.trim())
		const message = thread.messages[entry.index]
		return message?.role === 'assistant' && Boolean(message.text.trim())
	})
}

/**
 * The one muted line at the bottom of the live Worked block, only when it adds something the block
 * does not already show. It changes at stage boundaries, never with elapsed time:
 * a decision wait; the newest reasoning's headline (and that row stands down); a gap where nothing
 * runs and nothing new arrived ("Thinking"); otherwise nothing, because the newest entry is itself
 * the live element (a running action, a plan step in progress, narration being written).
 */
export function liveStatus(thread: ThreadState): LiveStatus {
	const phase = threadPhase(thread)
	if (phase === 'idle') return {}
	if (phase === 'waiting')
		return { stage: { text: 'Waiting for your decision', source: 'waiting' } }
	const newest = drawnEntries(thread).at(-1)
	if (newest?.kind === 'reasoning') {
		const segment = thread.reasoning[newest.id]
		const headline = segment ? statedStage(segment.text, segment.status === 'completed') : undefined
		return {
			stage: headline
				? { text: headline, source: 'reasoning' }
				: { text: 'Thinking', source: 'gap' },
			hiddenReasoningId: newest.id,
		}
	}
	if (newest?.kind === 'message') {
		const message = thread.messages[newest.index]
		// Narration being written, or the answer itself: the text is the live element.
		if (message?.phase !== 'commentary' || message.status !== 'completed') return {}
	}
	if (phase === 'tools') return {}
	if (
		latestPlanTurn(thread) === thread.turn &&
		thread.tasks.some((task) => task.status === 'in_progress')
	)
		return {}
	return { stage: { text: 'Thinking', source: 'gap' } }
}

/** True while the newest drawn entry is a commentary message still being written. */
export function narrationBeingWritten(thread: ThreadState): number | undefined {
	if (!thread.running || thread.stopReason !== undefined) return undefined
	const newest = drawnEntries(thread).at(-1)
	if (newest?.kind !== 'message') return undefined
	const message = thread.messages[newest.index]
	return message?.phase === 'commentary' && message.status !== 'completed'
		? newest.index
		: undefined
}

export function turnActivityLabel(thread: ThreadState, turn: number): string {
	// The outer disclosure names the work; its live Thinking/Waiting phase is a separate status.
	if (thread.running && thread.stopReason === undefined && thread.turn === turn) return 'Working'
	const timing = thread.turns[turn]
	const reason =
		timing?.reason ??
		timing?.stopReason ??
		(turn === thread.turn ? (thread.reason ?? thread.stopReason) : undefined)
	const milliseconds = turnDurationMs(thread, turn)
	const duration = milliseconds === undefined ? undefined : elapsedLabel(milliseconds)
	const outcome = transcriptOutcome(reason)
	const label =
		turn === thread.turn && thread.error
			? 'Work incomplete'
			: outcome === 'paused'
				? 'Paused'
				: outcome === 'stopped'
					? 'Stopped'
					: outcome === 'incomplete'
						? 'Work incomplete'
						: outcome === 'completed'
							? 'Worked'
							: 'Work details'
	return duration ? `${label}${label === 'Worked' ? ' for ' : ' · '}${duration}` : label
}

function historyState(node: HTMLElement): string | undefined {
	return node.closest<HTMLElement>('[data-history-state]')?.dataset.historyState
}
function pendingHistory(state: string | undefined) {
	return state === 'loading' || state === 'saved'
}

function motionOptions(node: HTMLElement, kind: keyof typeof transcriptMotion) {
	const style = node.ownerDocument.defaultView?.getComputedStyle(node)
	const raw = style?.getPropertyValue?.(`--transcript-${kind}-duration`).trim() ?? ''
	const parsed = Number.parseFloat(raw)
	const duration =
		Number.isFinite(parsed) && parsed >= 0 && /(?:ms|s)$/.test(raw)
			? parsed * (raw.endsWith('ms') ? 1 : 1000)
			: transcriptMotion[kind].duration
	const easing =
		style?.getPropertyValue?.(`--transcript-${kind}-ease`).trim() || transcriptMotion[kind].easing
	return { duration, easing }
}

/** A mounted history is the baseline. Only an admitted live suffix can enter. */
export function createTranscriptEntryMotion(node: HTMLElement) {
	const view = node.ownerDocument.defaultView
	const media = view?.matchMedia('(prefers-reduced-motion: reduce)')
	let previous:
		| {
				keys: string[]
				running: boolean
				turn: number
				history?: string
				enabled: boolean
		  }
		| undefined
	const effects = new Set<Animation>()
	const cancel = () => {
		for (const effect of effects) effect.cancel()
		effects.clear()
	}
	const reduce = () => {
		if (media?.matches) cancel()
	}
	media?.addEventListener('change', reduce)
	return {
		update(thread: ThreadState, enabled = true) {
			const entries = thread.timeline.filter((entry) =>
				entry.kind === 'message'
					? Boolean(
							thread.messages[entry.index]?.text.trim() ||
								thread.messages[entry.index]?.attachments?.length,
						)
					: entry.kind === 'reasoning'
						? Boolean(thread.reasoning[entry.id]?.text.trim())
						: Boolean(thread.tools[entry.id]),
			)
			const keys = entries.map(transcriptEntryKey)
			const history = historyState(node)
			const eligible =
				previous?.enabled &&
				enabled &&
				!pendingHistory(previous.history) &&
				!pendingHistory(history) &&
				(thread.running || previous.running) &&
				thread.turn >= previous.turn &&
				previous.keys.every((key, index) => keys[index] === key)
			const added =
				eligible && previous ? new Set(keys.slice(previous.keys.length)) : new Set<string>()
			previous = {
				keys,
				running: thread.running,
				turn: thread.turn,
				history,
				enabled,
			}
			if (!enabled || pendingHistory(history)) cancel()
			if (media?.matches || !added.size) return
			for (const row of node.querySelectorAll<HTMLElement>('[data-transcript-entry-key]')) {
				if (!added.has(row.dataset.transcriptEntryKey ?? '') || !row.animate) continue
				const effect = row.animate(
					[{ opacity: 0.65 }, { opacity: 1 }],
					motionOptions(node, 'entry'),
				)
				effect.id = 'namzu-transcript-entry'
				effects.add(effect)
				effect.addEventListener('finish', () => effects.delete(effect), {
					once: true,
				})
			}
		},
		dispose() {
			cancel()
			media?.removeEventListener('change', reduce)
		},
	}
}

/** A single readable label brightens gently; phase changes never overlap old text. */
export function createTranscriptPhaseMotion(node: HTMLElement, presence = false) {
	const view = node.ownerDocument.defaultView
	const media = view?.matchMedia('(prefers-reduced-motion: reduce)')
	let initialized = false
	let previous: string | undefined
	let previousHistory: string | undefined
	let previousEnabled = false
	let generation = 0
	const effects = new Set<Animation>()
	const opacity = (target: HTMLElement | null | undefined) => {
		const value = Number.parseFloat(target ? (view?.getComputedStyle(target).opacity ?? '1') : '0')
		return Number.isFinite(value) ? value : 1
	}
	const cancel = () => {
		generation++
		for (const effect of effects) effect.cancel()
		effects.clear()
	}
	const clearFrame = () => {
		for (const property of [
			'height',
			'overflow',
			'padding-top',
			'padding-bottom',
			'opacity',
			'display',
		])
			node.style.removeProperty(property)
	}
	const settle = () => {
		cancel()
		clearFrame()
		if (presence && !previous) node.style.display = 'none'
	}
	const reduce = () => {
		if (media?.matches) settle()
	}
	media?.addEventListener('change', reduce)
	const animate = (
		target: HTMLElement,
		frames: Keyframe[],
		options: KeyframeAnimationOptions,
		id: string,
		onFinish?: () => void,
	) => {
		const effect = target.animate(frames, options)
		effect.id = id
		effects.add(effect)
		const ownedGeneration = generation
		effect.addEventListener(
			'finish',
			() => {
				effects.delete(effect)
				if (generation === ownedGeneration) onFinish?.()
			},
			{ once: true },
		)
		return effect
	}
	return {
		update(label: string | undefined, enabled = true) {
			const history = historyState(node)
			const eligible =
				initialized &&
				enabled &&
				previousEnabled &&
				!pendingHistory(history) &&
				!pendingHistory(previousHistory)
			previousEnabled = enabled
			previousHistory = history
			if (initialized && label === previous) {
				if (!enabled || pendingHistory(history)) settle()
				return
			}
			initialized = true
			const text = node.querySelector<HTMLElement>('.transcript-phase-text')
			const old = previous
			const fromOpacity = opacity(text)
			const wasAnimating = effects.size > 0
			const fromHeight = node.getBoundingClientRect().height
			const style = view?.getComputedStyle(node)
			const from = {
				opacity: opacity(node),
				height: `${fromHeight}px`,
				paddingTop: fromHeight > 0 ? (style?.paddingTop ?? '0px') : '0px',
				paddingBottom: fromHeight > 0 ? (style?.paddingBottom ?? '0px') : '0px',
			}
			const interruptedFrame =
				effects.size > 0 && (from.opacity < 1 || fromHeight < node.scrollHeight)
			cancel()
			clearFrame()
			previous = label
			if (!eligible || media?.matches || !node.animate || !text) {
				if (presence && !label) node.style.display = 'none'
				return
			}
			const visibilityChanged = Boolean(old) !== Boolean(label)
			if (presence && (visibilityChanged || (label && interruptedFrame))) {
				const height = label ? node.getBoundingClientRect().height : 0
				const endStyle = view?.getComputedStyle(node)
				const end = {
					height: `${height}px`,
					paddingTop: label ? (endStyle?.paddingTop ?? '0px') : '0px',
					paddingBottom: label ? (endStyle?.paddingBottom ?? '0px') : '0px',
				}
				Object.assign(node.style, {
					...end,
					overflow: 'hidden',
					opacity: label ? '1' : '0',
				})
				animate(
					node,
					[from, end],
					motionOptions(node, 'frame'),
					'namzu-transcript-status-frame',
					settle,
				)
				animate(
					node,
					[{ opacity: fromHeight > 0 ? from.opacity : 0 }, { opacity: label ? 1 : 0 }],
					motionOptions(node, 'phase'),
					'namzu-transcript-status-opacity',
				)
				if (visibilityChanged) return
			}
			if (!label || !old || !text.animate) return
			animate(
				text,
				[{ opacity: Math.max(0.65, wasAnimating ? fromOpacity : 0.65) }, { opacity: 1 }],
				motionOptions(node, 'phase'),
				'namzu-transcript-phase-in',
			)
		},
		dispose() {
			settle()
			media?.removeEventListener('change', reduce)
		},
	}
}

export function useTranscriptEntryMotion(
	ref: RefObject<HTMLDivElement | null>,
	thread: ThreadState,
	enabled: boolean,
) {
	const motion = useRef<ReturnType<typeof createTranscriptEntryMotion> | null>(null)
	useLayoutEffect(() => {
		if (!ref.current) return
		motion.current ??= createTranscriptEntryMotion(ref.current)
		motion.current.update(thread, enabled)
	})
	useLayoutEffect(
		() => () => {
			motion.current?.dispose()
			motion.current = null
		},
		[],
	)
}

export function useTranscriptPhaseMotion(
	ref: RefObject<HTMLElement | null>,
	label: string | undefined,
	enabled: boolean,
	presence = false,
) {
	const motion = useRef<ReturnType<typeof createTranscriptPhaseMotion> | null>(null)
	useLayoutEffect(() => {
		if (!ref.current) return
		motion.current ??= createTranscriptPhaseMotion(ref.current, presence)
		motion.current.update(label, enabled)
	})
	useLayoutEffect(
		() => () => {
			motion.current?.dispose()
			motion.current = null
		},
		[],
	)
}
