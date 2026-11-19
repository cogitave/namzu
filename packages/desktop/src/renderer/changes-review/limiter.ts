/** Runs at most `limit` tasks at once; the rest wait their turn, in the order they were asked. */
export function createLimiter(limit: number) {
	let running = 0
	const waiting: (() => void)[] = []
	const next = () => {
		while (running < limit && waiting.length > 0) {
			running++
			;(waiting.shift() as () => void)()
		}
	}
	return <T>(task: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			waiting.push(() => {
				task()
					.then(resolve, reject)
					.finally(() => {
						running--
						next()
					})
			})
			next()
		})
}
