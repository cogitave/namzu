import { type RefObject, useLayoutEffect, useRef } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import { isTaskEntry, latestPlanTurn } from './plan-row.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
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
	source: 'waiting' | 'plan' | 'reasoning' | 'narration' | 'action' | 'fallback'
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

function currentAction(thread: ThreadState): string | undefined {
	for (let index = thread.timeline.length - 1; index >= 0; index--) {
		const entry = thread.timeline[index]
		if (!entry || entry.turn !== thread.turn || entry.kind !== 'tool') continue
		if (isTaskEntry(thread, entry)) continue
		const presentation = toolTranscriptPresentation(thread, entry.id)
		if (presentation?.state !== 'running') continue
		const text =
			presentation.kind === 'command' && presentation.tooltip
				? `Running ${presentation.tooltip}`
				: presentation.label
		const plain = stripMarkdown(text)
		if (plain) return clipStage(plain, 60)
	}
	return undefined
}

/** The last action to finish, in the past tense: the words that hold between two actions. */
function finishedAction(thread: ThreadState): string | undefined {
	for (let index = thread.timeline.length - 1; index >= 0; index--) {
		const entry = thread.timeline[index]
		if (!entry || entry.turn !== thread.turn || entry.kind !== 'tool') continue
		if (isTaskEntry(thread, entry)) continue
		const presentation = toolTranscriptPresentation(thread, entry.id)
		// Only an action that really finished: a cancelled or declined one is not something that was done.
		if (presentation?.state !== 'completed') continue
		const text =
			presentation.kind === 'command' && presentation.tooltip
				? `Ran ${presentation.tooltip}`
				: presentation.label
		const plain = stripMarkdown(text)
		if (plain) return clipStage(plain, 60)
		return undefined
	}
	return undefined
}

/**
 * What the work is doing right now, as a stage: it changes when the work enters a new stage and
 * holds for as long as that stage lasts. Never a function of elapsed time.
 */
export function liveStage(thread: ThreadState): LiveStage | undefined {
	const phase = threadPhase(thread)
	if (phase === 'idle') return undefined
	if (phase === 'waiting') return { text: 'Waiting for your decision', source: 'waiting' }
	if (latestPlanTurn(thread) === thread.turn) {
		const task = thread.tasks.find((candidate) => candidate.status === 'in_progress')
		const words = stripMarkdown(task?.activeForm?.trim() || task?.subject || '')
		if (words) return { text: clipStage(words), source: 'plan' }
	}
	// The latest statement that is complete: a later one still being written leaves the earlier one up.
	for (let index = thread.timeline.length - 1; index >= 0; index--) {
		const entry = thread.timeline[index]
		if (!entry || entry.turn !== thread.turn) continue
		const later = index < thread.timeline.length - 1
		if (entry.kind === 'reasoning') {
			const segment = thread.reasoning[entry.id]
			const text = segment
				? statedStage(segment.text, segment.status === 'completed' || later)
				: undefined
			if (text) return { text, source: 'reasoning' }
		} else if (entry.kind === 'message') {
			const message = thread.messages[entry.index]
			if (message?.role !== 'assistant' || message.phase !== 'commentary') continue
			const text = statedStage(message.text, message.status === 'completed' || later)
			if (text) return { text, source: 'narration' }
		}
	}
	const action = currentAction(thread)
	if (action) return { text: action, source: 'action' }
	// Between two actions nothing runs and nothing new was said: the last action's words hold, but
	// finished, so the line never claims a command is still running.
	if (phase !== 'thinking') {
		const done = finishedAction(thread)
		if (done) return { text: done, source: 'action' }
	}
	return { text: phase === 'thinking' ? 'Thinking' : 'Working', source: 'fallback' }
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
