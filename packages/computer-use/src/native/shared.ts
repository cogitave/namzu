import { NativeWinProcess, type NativeWinProcessOptions } from './process.js'

/**
 * What the monitor and the display adapter use of a helper process. Both take
 * it from {@link shareNativeProcess}, so that the lease the monitor begins and
 * the input the adapter sends meet in one helper, which is the only place a
 * lease can refuse an input.
 */
export type NativeHelper = Pick<
	NativeWinProcess,
	'isUp' | 'epoch' | 'hello' | 'warm' | 'release' | 'ready' | 'close' | 'request'
>

interface Entry {
	readonly process: NativeWinProcess
	holders: number
}

const entries = new Map<string, Entry>()
const spawners = new WeakMap<object, number>()
let spawnerIds = 0

function keyOf(options: NativeWinProcessOptions): string {
	let spawner = 0
	if (options.spawnHelper) {
		const known = spawners.get(options.spawnHelper)
		spawner = known ?? ++spawnerIds
		if (known === undefined) spawners.set(options.spawnHelper, spawner)
	}
	return `${options.executable}\0${spawner}`
}

/**
 * One helper process for every holder that names the same executable. The
 * process ends when the last holder closes; `release` (ending an idle helper)
 * only takes effect for a sole holder, since the others may hold a lease or a
 * watch in it.
 */
export function shareNativeProcess(options: NativeWinProcessOptions): NativeHelper {
	const key = keyOf(options)
	let entry = entries.get(key)
	if (!entry) {
		entry = { process: new NativeWinProcess(options), holders: 0 }
		entries.set(key, entry)
	}
	const shared = entry
	shared.holders++
	let open = true
	const inner = shared.process
	return {
		get isUp() {
			return inner.isUp
		},
		get epoch() {
			return inner.epoch
		},
		get hello() {
			return inner.hello
		},
		warm: () => inner.warm(),
		ready: () => inner.ready(),
		request: (request, limitMs, signal) => inner.request(request, limitMs, signal),
		release: () => {
			if (shared.holders === 1) inner.release()
		},
		close: async () => {
			if (!open) return
			open = false
			shared.holders--
			if (shared.holders > 0) return
			if (entries.get(key) === shared) entries.delete(key)
			await inner.close()
		},
	}
}
