import { type RefObject, useLayoutEffect, useRef } from 'react'
import { type ThreadState, type TimelineEntry, threadPhase } from '../shared/projection.js'
import { elapsedLabel } from './transcript-layout.js'

export const transcriptMotion = {
	entry: { duration: 150, easing: 'ease-out' },
	phase: { duration: 300, easing: 'cubic-bezier(0.19, 1, 0.22, 1)' },
	frame: { duration: 200, easing: 'ease-out' },
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

export function turnActivityLabel(thread: ThreadState, turn: number): string {
	if (thread.running && thread.stopReason === undefined && thread.turn === turn)
		return livePhaseLabel(thread) ?? 'Working'
	const timing = thread.turns[turn]
	const reason =
		timing?.reason ??
		timing?.stopReason ??
		(turn === thread.turn ? (thread.reason ?? thread.stopReason) : undefined)
	const duration =
		timing?.startedAt !== undefined && timing.endedAt !== undefined
			? elapsedLabel(timing.endedAt - timing.startedAt)
			: undefined
	const label =
		reason === 'paused'
			? 'Paused'
			: reason === 'cancelled'
				? 'Stopped'
				: (reason && reason !== 'end_turn') || (turn === thread.turn && thread.error)
					? 'Work incomplete'
					: 'Worked'
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
		| { keys: string[]; running: boolean; turn: number; history?: string; enabled: boolean }
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
							thread.messages[entry.index]?.text ||
								thread.messages[entry.index]?.attachments?.length,
						)
					: entry.kind === 'reasoning'
						? Boolean(thread.reasoning[entry.id]?.text)
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
			previous = { keys, running: thread.running, turn: thread.turn, history, enabled }
			if (!enabled || pendingHistory(history)) cancel()
			if (media?.matches || !added.size) return
			for (const row of node.querySelectorAll<HTMLElement>('[data-transcript-entry-key]')) {
				if (!added.has(row.dataset.transcriptEntryKey ?? '') || !row.animate) continue
				const effect = row.animate(
					[
						{ opacity: 0, transform: 'translateY(4px)' },
						{ opacity: 1, transform: 'none' },
					],
					motionOptions(node, 'entry'),
				)
				effect.id = 'namzu-transcript-entry'
				effects.add(effect)
				effect.addEventListener('finish', () => effects.delete(effect), { once: true })
			}
		},
		dispose() {
			cancel()
			media?.removeEventListener('change', reduce)
		},
	}
}

/** The outgoing label is decorative only. It never retains an old accessible status. */
export function createTranscriptPhaseMotion(node: HTMLElement, presence = false) {
	const view = node.ownerDocument.defaultView
	const media = view?.matchMedia('(prefers-reduced-motion: reduce)')
	let initialized = false
	let previous: string | undefined
	let previousHistory: string | undefined
	let previousEnabled = false
	let outgoing: HTMLElement | undefined
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
		outgoing?.remove()
		outgoing = undefined
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
			const reverseOpacity = outgoing?.textContent === label ? opacity(outgoing) : 0
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
				Object.assign(node.style, { ...end, overflow: 'hidden', opacity: label ? '1' : '0' })
				animate(node, [from, end], motionOptions(node, 'frame'), 'namzu-transcript-status-frame')
				animate(
					node,
					[{ opacity: fromHeight > 0 ? from.opacity : 0 }, { opacity: label ? 1 : 0 }],
					motionOptions(node, 'phase'),
					'namzu-transcript-status-opacity',
					settle,
				)
				if (visibilityChanged) return
			}
			if (!label || !old || !text.animate) return
			outgoing = text.cloneNode(false) as HTMLElement
			outgoing.textContent = old
			outgoing.setAttribute('aria-hidden', 'true')
			outgoing.dataset.transcriptPhaseOutgoing = ''
			text.parentElement?.append(outgoing)
			const ghost = outgoing
			animate(
				ghost,
				[{ opacity: fromOpacity }, { opacity: 0 }],
				motionOptions(node, 'phase'),
				'namzu-transcript-phase-out',
				() => {
					ghost.remove()
					if (outgoing === ghost) outgoing = undefined
				},
			)
			animate(
				text,
				[{ opacity: reverseOpacity }, { opacity: 1 }],
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
