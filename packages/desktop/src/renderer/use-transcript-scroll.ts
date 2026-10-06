import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const latestThreshold = 48

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
		const bottom = () => Math.max(0, node.scrollHeight - node.clientHeight)
		const update = () => {
			if (!current) return
			setAway(bottom() - node.scrollTop > latestThreshold)
		}
		const onScroll = () => {
			if (!current) return
			const atLatest = bottom() - node.scrollTop <= latestThreshold
			if (atLatest) explicitJump = false
			follow.current = atLatest || explicitJump
			update()
		}
		const cancelJump = () => {
			explicitJump = false
			follow.current = false
		}
		const onWheel = (event: WheelEvent) => {
			if (explicitJump || event.deltaY < 0) cancelJump()
		}
		const onTouch = () => {
			if (explicitJump) cancelJump()
		}
		const onKey = (event: KeyboardEvent) => {
			if (!event.defaultPrevented && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) cancelJump()
		}
		const onScrollEnd = () => {
			if (!current || !explicitJump) return
			explicitJump = false
			if (follow.current) node.scrollTop = bottom()
			update()
		}
		const schedule = () => {
			if (frame !== undefined) return
			frame = requestAnimationFrame(() => {
				frame = undefined
				if (!current) return
				if (follow.current && !explicitJump && Math.abs(node.scrollTop - bottom()) > 0.5)
					node.scrollTop = bottom()
				update()
			})
		}
		const observer = new ResizeObserver(schedule)
		observer.observe(node)
		if (node.firstElementChild) observer.observe(node.firstElementChild)
		node.addEventListener('scroll', onScroll, { passive: true })
		node.addEventListener('scrollend', onScrollEnd, { passive: true })
		node.addEventListener('wheel', onWheel, { passive: true })
		node.addEventListener('touchstart', onTouch, { passive: true })
		node.addEventListener('keydown', onKey)
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
			if (jump.current === toLatest) jump.current = undefined
		}
	}, [node, owner, follow])
	const jumpToLatest = useCallback(() => jump.current?.(), [])
	return { ref, showLatest: Boolean(owner && node && away), jumpToLatest }
}
