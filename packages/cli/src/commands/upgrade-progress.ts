import { NAMZU_COMPACT_WORDMARK, NAMZU_WORDMARK } from '../tui/logo.js'

export function upgradeFrame(tick: number, columns: number, complete = false): string {
	const logo = columns >= 28 ? NAMZU_WORDMARK : NAMZU_COMPACT_WORDMARK
	const width = Math.max(...logo.split('\n').map((line) => line.length))
	const edge = tick % width
	const lines = logo.split('\n').map((line) =>
		Array.from(line, (char, x) => {
			if (char === ' ') return char
			const color = complete || x < edge ? 92 : x === edge ? 97 : 90
			return `\x1b[${color}m${char}\x1b[0m`
		}).join(''),
	)
	return lines.join('\n')
}

/** A bounded two-line activity indicator; npm has no trustworthy percent API. */
export function startUpgradeProgress(
	stream: {
		readonly isTTY?: boolean
		readonly columns?: number
		write: (text: string) => unknown
	} = process.stderr,
):
	| {
			stop: (complete?: boolean) => void
	  }
	| undefined {
	if (
		!stream.isTTY ||
		(stream.columns ?? 0) < 12 ||
		process.env.TERM === 'dumb' ||
		process.env.NO_COLOR !== undefined
	)
		return
	let tick = 0
	let rows = 0
	let stopped = false
	const clear = () => {
		if (rows) stream.write(`\x1b[${rows}A\r\x1b[J`)
		rows = 0
	}
	const draw = (complete = false) => {
		clear()
		const frame = upgradeFrame(tick++, stream.columns ?? 80, complete)
		stream.write(`${frame}\n`)
		rows = frame.split('\n').length
	}
	const onExit = () => clear()
	process.once('exit', onExit)
	draw()
	const timer = setInterval(draw, 90)
	timer.unref()
	return {
		stop(complete = false) {
			if (stopped) return
			stopped = true
			clearInterval(timer)
			process.removeListener('exit', onExit)
			if (complete) draw(true)
			else clear()
		},
	}
}
