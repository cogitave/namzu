import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
	createAutoScrollMark,
	disclosureSettleMs,
	followAfterDisclosure,
	latestThreshold,
	panelPausesFollow,
} from './scroll-follow.js'

/** Keep reading position independent of streaming; follow only after reaching the end. */
export function useTranscriptScroll(
	owner: string,
	transcript: { current: HTMLDivElement | null },
	follow: { current: boolean },
) {
	const [node, setNode] = useState<HTMLDivElement | null>(null)
	const [away, setAway] = useState(false)
	const jump = useRef<(() => void) | undefined>(undefined)
	const ref = useCallback(
		(value: HTMLDivElement | null) => {
			transcript.current = value
			setNode(value)
		},
		[transcript],
	)
	useLayoutEffect(() => {
		if (!node || !owner) {
			setAway(false)
			return
		}
		let current = true
		let frame: number | undefined
		let explicitJump = false
		let disclosure: ReturnType<typeof setTimeout> | undefined
		let disclosureWasFollowing = false
		let disclosureMoved = false
		let disclosureTrigger: Element | null = null
		const auto = createAutoScrollMark()
		const bottom = () => Math.max(0, node.scrollHeight - node.clientHeight)
		// Every scroll the code makes is marked, so its event is not read as the reader leaving the end.
		const pin = () => {
			const top = bottom()
			auto.mark(top)
			node.scrollTop = top
		}
		const update = () => {
			if (!current) return
			setAway(bottom() - node.scrollTop > latestThreshold)
		}
		const onScroll = () => {
			if (!current) return
			if (auto.consume(node.scrollTop)) {
				update()
				return
			}
			const atLatest = bottom() - node.scrollTop <= latestThreshold
			if (atLatest) explicitJump = false
			follow.current = atLatest || explicitJump
			update()
		}
		const cancelJump = () => {
			if (disclosure !== undefined) disclosureMoved = true
			explicitJump = false
			follow.current = false
		}
		const onWheel = (event: WheelEvent) => {
			if (explicitJump || event.deltaY < 0) cancelJump()
		}
		const onTouch = () => {
			if (disclosure !== undefined) disclosureMoved = true
			if (explicitJump) cancelJump()
		}
		const onKey = (event: KeyboardEvent) => {
			if (!event.defaultPrevented && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) cancelJump()
		}
		const onScrollEnd = () => {
			if (!current || !explicitJump) return
			explicitJump = false
			if (follow.current) pin()
			update()
		}
		// Opening a disclosure grows the page under the reader. A reader at the end keeps following
		// while a small panel grows, so nothing jumps; a panel taller than a third of the view is
		// being read, so following pauses for it and resumes only if the reader is back at the end.
		const panelOf = () =>
			document.getElementById(disclosureTrigger?.getAttribute('aria-controls') ?? '')
		const tallPanel = () =>
			panelPausesFollow(panelOf()?.getBoundingClientRect().height, node.clientHeight)
		const onDisclosure = (event: Event) => {
			const trigger =
				event.target instanceof Element ? event.target.closest('[aria-expanded]') : null
			if (!trigger || !node.contains(trigger) || trigger.getAttribute('aria-expanded') !== 'false')
				return
			if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
			// A second click inside the window keeps the first one's answer.
			if (disclosure === undefined) {
				disclosureWasFollowing = follow.current
				disclosureMoved = false
			}
			disclosureTrigger = trigger
			if (!disclosureWasFollowing) follow.current = false
			if (disclosure !== undefined) clearTimeout(disclosure)
			disclosure = setTimeout(() => {
				disclosure = undefined
				if (!current) return
				if (
					followAfterDisclosure(bottom() - node.scrollTop, {
						wasFollowing: disclosureWasFollowing,
						moved: disclosureMoved,
						// The trigger names its panel only once open, so look it up when the panel has grown.
						panelHeight: panelOf()?.getBoundingClientRect().height,
						viewportHeight: node.clientHeight,
					})
				)
					follow.current = true
				schedule()
			}, disclosureSettleMs)
		}
		const settle = () => {
			if (!current) return
			if (disclosure !== undefined && tallPanel()) follow.current = false
			if (follow.current && !explicitJump && Math.abs(node.scrollTop - bottom()) > 0.5) pin()
			update()
		}
		const schedule = () => {
			if (frame !== undefined) return
			frame = requestAnimationFrame(() => {
				frame = undefined
				settle()
			})
		}
		// A resize is pinned before the frame is painted, so a growing panel never shows a frame
		// that is off the end.
		const observer = new ResizeObserver(settle)
		observer.observe(node)
		if (node.firstElementChild) observer.observe(node.firstElementChild)
		node.addEventListener('scroll', onScroll, { passive: true })
		node.addEventListener('scrollend', onScrollEnd, { passive: true })
		node.addEventListener('wheel', onWheel, { passive: true })
		node.addEventListener('touchstart', onTouch, { passive: true })
		node.addEventListener('keydown', onKey)
		node.addEventListener('click', onDisclosure, true)
		node.addEventListener('keydown', onDisclosure, true)
		const toLatest = () => {
			if (!current) return
			const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
			explicitJump = !reduced
			follow.current = true
			node.scrollTo({ top: bottom(), behavior: reduced ? 'instant' : 'smooth' })
			update()
		}
		jump.current = toLatest
		update()
		schedule()
		return () => {
			current = false
			observer.disconnect()
			if (frame !== undefined) cancelAnimationFrame(frame)
			node.removeEventListener('scroll', onScroll)
			node.removeEventListener('scrollend', onScrollEnd)
			node.removeEventListener('wheel', onWheel)
			node.removeEventListener('touchstart', onTouch)
			node.removeEventListener('keydown', onKey)
			node.removeEventListener('click', onDisclosure, true)
			node.removeEventListener('keydown', onDisclosure, true)
			if (disclosure !== undefined) clearTimeout(disclosure)
			if (jump.current === toLatest) jump.current = undefined
		}
	}, [node, owner, follow])
	const jumpToLatest = useCallback(() => jump.current?.(), [])
	return { ref, showLatest: Boolean(owner && node && away), jumpToLatest }
}
