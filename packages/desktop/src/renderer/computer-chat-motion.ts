import { useLayoutEffect, useRef, useState } from 'react'

export type ComputerChatLayout = 'hidden' | 'split' | 'floating'

type Frame = {
	left: number
	top: number
	width: number
	height: number
	opacity: number
	radius: number
}
type Capture = {
	frame: Frame
	laneOpacity: number
	headerHeight: number
	headerOpacity: number
}
interface MotionTarget {
	layout: ComputerChatLayout
	rendered: boolean
	visible: boolean
}

const duration = 260
const easing = 'cubic-bezier(0.22, 0, 0.36, 1)'
const pinProperties = [
	'position',
	'grid-row',
	'grid-column',
	'left',
	'top',
	'right',
	'bottom',
	'width',
	'height',
	'min-height',
	'max-width',
	'max-height',
	'border-radius',
	'opacity',
] as const

/** Own only visual effects on the persistent chat; never clone or replace authored content. */
export function createComputerChatMotion(stage: HTMLElement, onHidden: () => void) {
	const view = stage.ownerDocument.defaultView
	const media = view?.matchMedia('(prefers-reduced-motion: reduce)')
	let prepared: Capture | null = null
	let target: MotionTarget | null = null
	let frameAnimation: Animation | null = null
	let childAnimations: Animation[] = []
	let disposed = false
	let pinned = false
	const lane = () => stage.querySelector<HTMLElement>('.conversation-lane')
	const header = () => stage.querySelector<HTMLElement>('.computer-floating-chat-heading')
	const style = (node: HTMLElement) => view?.getComputedStyle(node)
	const number = (value: string | undefined, fallback: number) => {
		const parsed = Number.parseFloat(value ?? '')
		return Number.isFinite(parsed) ? parsed : fallback
	}
	const read = (): Capture => {
		const rect = stage.getBoundingClientRect()
		const current = style(stage)
		const content = lane()
		const heading = header()
		return {
			frame: {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
				opacity: number(current?.opacity, 1),
				radius: number(current?.borderRadius, 0),
			},
			laneOpacity: content ? number(style(content)?.opacity, 1) : 1,
			headerHeight: heading?.getBoundingClientRect().height ?? 0,
			headerOpacity: heading ? number(style(heading)?.opacity, 1) : 0,
		}
	}
	const anchor = (fallback: Frame): Frame => {
		const bubble = stage.parentElement?.querySelector<HTMLElement>('.computer-chat-launcher')
		const rect = bubble?.getBoundingClientRect()
		return {
			left: rect?.width ? rect.left : fallback.left + fallback.width - 32,
			top: rect?.height ? rect.top : fallback.top + fallback.height - 32,
			width: rect?.width || 32,
			height: rect?.height || 32,
			opacity: 0,
			radius: 20,
		}
	}
	const cancel = () => {
		const active = frameAnimation
		frameAnimation = null
		active?.cancel()
		for (const animation of childAnimations) animation.cancel()
		childAnimations = []
	}
	const clear = () => {
		if (pinned) for (const property of pinProperties) stage.style.removeProperty(property)
		pinned = false
		for (const node of [lane(), header()]) {
			if (!node) continue
			for (const property of [
				'opacity',
				'display',
				'height',
				'min-height',
				'padding-top',
				'padding-bottom',
			])
				node.style.removeProperty(property)
		}
		delete stage.dataset.chatMotion
	}
	const settle = () => {
		cancel()
		if (!target?.rendered || target.visible) clear()
		else {
			// Keep the final invisible frame until React commits the hidden layout.
			stage.style.opacity = '0'
			stage.dataset.chatMotion = 'exiting'
			onHidden()
		}
	}
	const changed = (next: MotionTarget) =>
		!target ||
		target.layout !== next.layout ||
		target.rendered !== next.rendered ||
		target.visible !== next.visible
	const update = (next: MotionTarget) => {
		if (disposed) return
		if (!changed(next)) {
			prepared = null
			return
		}
		const previous = target
		const from = prepared ?? (pinned ? read() : null)
		prepared = null
		target = { ...next }
		cancel()
		clear()
		if (!next.rendered) return
		const destination = read()
		const start =
			from && from.frame.width > 0 && from.frame.height > 0
				? from
				: {
						...destination,
						frame: anchor(destination.frame),
						laneOpacity: 0,
						headerHeight: 0,
						headerOpacity: 0,
					}
		const end = next.visible ? destination.frame : anchor(start.frame)
		if (media?.matches || !stage.animate) {
			if (!next.visible) {
				stage.style.opacity = '0'
				pinned = true
				onHidden()
			}
			return
		}
		const parentNode = stage.parentElement
		const parent = parentNode?.getBoundingClientRect()
		const origin = {
			left: (parent?.left ?? 0) + (parentNode?.clientLeft ?? 0),
			top: (parent?.top ?? 0) + (parentNode?.clientTop ?? 0),
		}
		const keyframe = (frame: Frame) => ({
			left: `${frame.left - origin.left}px`,
			top: `${frame.top - origin.top}px`,
			width: `${frame.width}px`,
			height: `${frame.height}px`,
			opacity: frame.opacity,
			borderRadius: `${frame.radius}px`,
		})
		Object.assign(stage.style, {
			position: 'absolute',
			gridRow: 'auto',
			gridColumn: 'auto',
			right: 'auto',
			bottom: 'auto',
			minHeight: '0',
			maxWidth: 'none',
			maxHeight: 'none',
			...keyframe(end),
		})
		pinned = true
		stage.dataset.chatMotion = next.visible ? 'entering' : 'exiting'
		const animation = stage.animate([keyframe(start.frame), keyframe(end)], {
			duration,
			easing,
			fill: 'both',
		})
		animation.id = 'namzu-computer-chat-frame'
		frameAnimation = animation
		const content = lane()
		if (content) {
			const endOpacity = next.visible ? 1 : 0
			content.style.opacity = `${endOpacity}`
			const reveal = next.visible && (!previous?.visible || start.laneOpacity < 1)
			childAnimations.push(
				content.animate([{ opacity: start.laneOpacity }, { opacity: endOpacity }], {
					duration: reveal ? 150 : 120,
					delay: reveal ? 70 : 0,
					easing,
					fill: 'both',
				}),
			)
		}
		const heading = header()
		if (heading) {
			const height = next.visible && next.layout === 'floating' ? 44 : 0
			const opacity = height > 0 ? 1 : 0
			Object.assign(heading.style, {
				display: 'flex',
				height: `${height}px`,
				minHeight: '0',
				paddingTop: '0',
				paddingBottom: '0',
				opacity: `${opacity}`,
			})
			childAnimations.push(
				heading.animate(
					[
						{ height: `${start.headerHeight}px`, opacity: start.headerOpacity },
						{ height: `${height}px`, opacity },
					],
					{ duration, easing, fill: 'both' },
				),
			)
		}
		animation.addEventListener('finish', () => {
			if (frameAnimation !== animation || disposed) return
			settle()
		})
	}
	const reduce = () => {
		if (media?.matches) settle()
	}
	media?.addEventListener('change', reduce)
	return {
		/** Sample before React changes the layout; an interrupted animation's real box is retained. */
		capture() {
			if (disposed) return
			const current = read()
			prepared =
				current.frame.width > 0 && current.frame.height > 0
					? current
					: {
							...current,
							frame: anchor(current.frame),
							laneOpacity: 0,
							headerHeight: 0,
							headerOpacity: 0,
						}
		},
		update,
		dispose() {
			disposed = true
			prepared = null
			cancel()
			clear()
			media?.removeEventListener('change', reduce)
		},
	}
}

/** Retain the visible layout through exit, keeping the one textarea mounted and inert. */
export function useComputerChatMotion({
	enabled,
	layout,
	minimized,
	owner,
}: {
	enabled: boolean
	layout: ComputerChatLayout
	minimized: boolean
	owner: string
}) {
	const stageRef = useRef<HTMLDivElement>(null)
	const motion = useRef<{
		owner: string
		node: HTMLDivElement
		controller: ReturnType<typeof createComputerChatMotion>
	} | null>(null)
	const [retained, setRetained] = useState<{ owner: string; layout: ComputerChatLayout }>({
		owner,
		layout: 'hidden',
	})
	const desired = enabled && layout !== 'hidden' && !(layout === 'floating' && minimized)
	const renderedLayout = !enabled
		? 'hidden'
		: desired
			? layout
			: retained.owner === owner
				? retained.layout
				: 'hidden'
	const enabledRef = useRef(enabled)
	enabledRef.current = enabled
	useLayoutEffect(() => {
		const node = stageRef.current
		if (motion.current && (motion.current.owner !== owner || motion.current.node !== node)) {
			motion.current.controller.dispose()
			motion.current = null
		}
		if (!node) return
		if (!motion.current) {
			motion.current = {
				owner,
				node,
				controller: createComputerChatMotion(node, () => setRetained({ owner, layout: 'hidden' })),
			}
		}
		if (!enabled) {
			motion.current.controller.update({ layout: 'hidden', rendered: false, visible: false })
			if (retained.layout !== 'hidden' || retained.owner !== owner)
				setRetained({ owner, layout: 'hidden' })
			return
		}
		if (desired && (retained.layout !== layout || retained.owner !== owner))
			setRetained({ owner, layout })
		motion.current.controller.update({
			layout: renderedLayout,
			rendered: renderedLayout !== 'hidden',
			visible: desired,
		})
	})
	useLayoutEffect(
		() => () => {
			motion.current?.controller.dispose()
			motion.current = null
		},
		[],
	)
	return {
		stageRef,
		renderedLayout,
		interactive: !enabled || desired,
		capture() {
			if (enabledRef.current) motion.current?.controller.capture()
		},
	}
}
