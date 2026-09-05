import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const [kind, cwd, stateRoot, recordPath, readyPath, releasePath] = process.argv.slice(2)
const read = fs.readFileSync
const pause = new Int32Array(new SharedArrayBuffer(4))
let announced = false

// Force independent processes to observe the same absent record before any
// may initialize it. This makes the old read-then-overwrite race deterministic.
fs.readFileSync = ((...args: Parameters<typeof read>) => {
	try {
		return read(...args)
	} catch (error) {
		if (
			!announced &&
			args[0] === recordPath &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			announced = true
			fs.writeFileSync(readyPath, '')
			const deadline = Date.now() + 20_000
			while (!fs.existsSync(releasePath)) {
				if (Date.now() >= deadline) throw new Error('first-use test barrier timed out')
				Atomics.wait(pause, 0, 0, 10)
			}
		}
		throw error
	}
}) as typeof fs.readFileSync
syncBuiltinESMExports()

if (kind === 'identity') {
	const { loadIdentity } = await import('../identity.js')
	process.stdout.write(JSON.stringify(loadIdentity(stateRoot)))
} else {
	const { openSessions } = await import('../../sessions/store.js')
	const sessions = await openSessions(cwd, { stateRoot })
	process.stdout.write(JSON.stringify({ topicId: sessions.topicId }))
}
