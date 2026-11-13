import { useLayoutEffect, useMemo, useRef, useState } from 'react'

const thresholds = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
] as const

/** Ordered two-pixel squares stay square as the header changes width. */
export function BrandDither() {
	const element = useRef<SVGSVGElement>(null)
	const [width, setWidth] = useState(288)
	// The band's own height, so the squares are 2 by 2 whatever the header's height is.
	const [height, setHeight] = useState(36)
	useLayoutEffect(() => {
		const parent = element.current?.parentElement
		if (!parent) return
		const resize = () => {
			setWidth(Math.max(1, Math.round(parent.clientWidth)))
			setHeight(Math.max(1, Math.round(parent.clientHeight)))
		}
		resize()
		const observer = new ResizeObserver(resize)
		observer.observe(parent)
		return () => observer.disconnect()
	}, [])
	const pixels = useMemo(() => {
		const squares: string[] = []
		for (let y = 0; y < height; y += 2) {
			for (let x = 0; x < width; x += 2) {
				const density = 0.06 + 0.72 * (1 - x / width) ** 1.4
				if ((thresholds[(y / 2) % 4][(x / 2) % 4] + 0.5) / 16 < density)
					squares.push(`M${x} ${y}h2v2h-2z`)
			}
		}
		return squares.join('')
	}, [width, height])
	return (
		<svg
			ref={element}
			className="brand-dither"
			data-brand-dither
			aria-hidden="true"
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			shapeRendering="crispEdges"
		>
			<path d={pixels} />
		</svg>
	)
}
