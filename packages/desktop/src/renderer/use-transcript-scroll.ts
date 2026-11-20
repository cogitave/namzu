import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { reducedMotion } from './motion-setting.js'
import {
	createAutoScrollMark,
	createReaderInput,
	disclosureSettleMs,
	followAfterDisclosure,
	latestThreshold,
	panelPausesFollow,
	readScroll,
} from './scroll-follow.js'

/** Keep reading position independent of streaming; follow only after reaching the end. */
/** How long a fling keeps scrolling after the finger lifts and still reads as the reader's. */
const touchCoastMs = 1_500

export function useTranscriptScroll(
	owner: string,
	transcript: { current: HTMLDivElement | null },
	follow: { current: boolean },
	/** The reader stopped scrolling, or the window is closing: a moment to keep the position. */
	onRest?: () => void,
) {
	const rest = useRef(onRest)
	rest.current = onRest
	const [node, setNode] = useState<HTMLDivElement | null>(null)
	const [away, setAway] = useState(false)
	const jump = useRef<(() => void) | undefined>(undefined)
	const pinNowRef = useRef<(() => void) | undefined>(undefined)
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
		const reader = createReaderInput()
		let lastTop = node.scrollTop
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
			const top = node.scrollTop
			const movedUp = top < lastTop
			lastTop = top
			if (auto.consume(top)) {
				update()
				return
			}
			const atLatest = bottom() - top <= latestThreshold
			if (atLatest) explicitJump = false
			// A smooth jump to the end scrolls on its own and keeps following until it arrives.
			if (explicitJump) {
				follow.current = true
				update()
				return
			}
			const read = readScroll({
				following: follow.current,
				atLatest,
				movedUp,
				fromReader: reader.recent(),
			})
			follow.current = read.follow
			if (read.repin) {
				pin()
				lastTop = node.scrollTop
			}
			update()
		}
		const cancelJump = () => {
			if (disclosure !== undefined) disclosureMoved = true
			explicitJump = false
			follow.current = false
		}
		const onWheel = (event: WheelEvent) => {
			reader.touch()
			if (explicitJump || event.deltaY < 0) cancelJump()
		}
		// A drag keeps the reader's mark fresh, and a lifted finger leaves a fling that scrolls on.
		const onTouchMove = () => reader.touch()
		const onTouchEnd = () => reader.touch(touchCoastMs)
		const onTouch = () => {
			reader.touch()
			if (disclosure !== undefined) disclosureMoved = true
			if (explicitJump) cancelJump()
		}
		const onKey = (event: KeyboardEvent) => {
			reader.touch()
			if (!event.defaultPrevented && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) cancelJump()
		}
		// Only a press on the scrollbar moves the scroller: a click on a card or a button inside the
		// transcript does not, and a card that closes under it must not read as the reader scrolling.
		const onPointerDown = (event: PointerEvent) => {
			if (
				event.target === node &&
				event.clientX >= node.getBoundingClientRect().left + node.clientLeft + node.clientWidth
			)
				reader.hold()
		}
		const onPointerUp = () => reader.release()
		// A release on the scrollbar, or outside the window, may send no pointerup: a move with no
		// button down says the press is over.
		const onPointerMove = (event: PointerEvent) => {
			if (event.buttons === 0) reader.release()
		}
		const onScrollEnd = () => {
			if (!current) return
			rest.current?.()
			if (!explicitJump) return
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
		// A window that closes mid-read keeps where the reader was, as it does after a pause.
		const onPageHide = () => rest.current?.()
		window.addEventListener('pagehide', onPageHide)
		node.addEventListener('wheel', onWheel, { passive: true })
		node.addEventListener('touchstart', onTouch, { passive: true })
		node.addEventListener('touchmove', onTouchMove, { passive: true })
		node.addEventListener('touchend', onTouchEnd, { passive: true })
		node.addEventListener('keydown', onKey)
		node.addEventListener('pointerdown', onPointerDown, { passive: true })
		window.addEventListener('pointerup', onPointerUp, true)
		window.addEventListener('pointermove', onPointerMove, true)
		window.addEventListener('pointercancel', onPointerUp, true)
		node.addEventListener('click', onDisclosure, true)
		node.addEventListener('keydown', onDisclosure, true)
		const toLatest = () => {
			if (!current) return
			const reduced = reducedMotion(window)?.matches === true
			explicitJump = !reduced
			follow.current = true
			node.scrollTo({ top: bottom(), behavior: reduced ? 'instant' : 'smooth' })
			update()
		}
		jump.current = toLatest
		const pinNow = () => {
			if (!current) return
			pin()
			lastTop = node.scrollTop
			update()
		}
		pinNowRef.current = pinNow
		update()
		schedule()
		return () => {
			current = false
			observer.disconnect()
			if (frame !== undefined) cancelAnimationFrame(frame)
			node.removeEventListener('scroll', onScroll)
			node.removeEventListener('scrollend', onScrollEnd)
			window.removeEventListener('pagehide', onPageHide)
			node.removeEventListener('wheel', onWheel)
			node.removeEventListener('touchstart', onTouch)
			node.removeEventListener('touchmove', onTouchMove)
			node.removeEventListener('touchend', onTouchEnd)
			node.removeEventListener('keydown', onKey)
			node.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('pointerup', onPointerUp, true)
			window.removeEventListener('pointermove', onPointerMove, true)
			window.removeEventListener('pointercancel', onPointerUp, true)
			node.removeEventListener('click', onDisclosure, true)
			node.removeEventListener('keydown', onDisclosure, true)
			if (disclosure !== undefined) clearTimeout(disclosure)
			if (jump.current === toLatest) jump.current = undefined
			if (pinNowRef.current === pinNow) pinNowRef.current = undefined
		}
	}, [node, owner, follow])
	const jumpToLatest = useCallback(() => jump.current?.(), [])
	/** Follow from now on and bring the view to the end: the person just sent a message. */
	const pinNow = useCallback(() => pinNowRef.current?.(), [])
	return { ref, showLatest: Boolean(owner && node && away), jumpToLatest, pinNow }
}
