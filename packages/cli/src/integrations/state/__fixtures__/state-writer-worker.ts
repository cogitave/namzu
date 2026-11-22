import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

/**
 * One of two processes changing the same state file. The barriers make the
 * lost-update order happen every time, whatever the machine's speed:
 *
 * - `first` takes the file's lock, reads, and stops just before its rename
 *   until `second` has found that lock held.
 * - `second` starts while `first` is stopped. When its lock attempt meets the
 *   held lock it says so, waits until `first` has let go, and goes on.
 *
 * Without the lock, `second` never meets one, `first` never moves, and the
 * test fails on Vitest's own timeout rather than on a clock of its own.
 */

const [kind, role, userHome, target, value, markers] = process.argv.slice(2) as [
	'trust' | 'approvals' | 'config',
	'first' | 'second',
	string,
	string,
	string,
	string,
]
const namzuHome = join(userHome, '.namzu')
const file = join(
	namzuHome,
	kind === 'trust' ? 'trust.json' : kind === 'approvals' ? 'mcp-approvals.json' : 'config.yaml',
)
const lock = `${file}.lock`
const pause = new Int32Array(new SharedArrayBuffer(4))
const waitFor = (ready: () => boolean): void => {
	while (!ready()) Atomics.wait(pause, 0, 0, 5)
}

if (role === 'first') {
	const rename = fs.renameSync
	fs.renameSync = ((...args: Parameters<typeof rename>) => {
		if (String(args[1]) === file) {
			fs.writeFileSync(join(markers, 'first-inside'), '')
			waitFor(() => fs.existsSync(join(markers, 'second-blocked')))
		}
		return rename(...args)
	}) as typeof fs.renameSync
} else {
	const open = fs.openSync
	let announced = false
	fs.openSync = ((...args: Parameters<typeof open>) => {
		try {
			return open(...args)
		} catch (error) {
			if (
				String(args[0]) === lock &&
				(error as NodeJS.ErrnoException).code === 'EEXIST' &&
				!announced
			) {
				announced = true
				fs.writeFileSync(join(markers, 'second-blocked'), '')
				waitFor(() => !fs.existsSync(lock))
			}
			throw error
		}
	}) as typeof fs.openSync
}
syncBuiltinESMExports()

if (kind === 'trust') {
	const { trustDir } = await import('../../trust/store.js')
	trustDir(target, userHome)
} else if (kind === 'approvals') {
	const { approveProjectMcpServers } = await import('../../mcp/project-approval.js')
	approveProjectMcpServers(namzuHome, target, { [value]: { command: value } } as never)
} else {
	const { setUserConfigValue } = await import('../../../config/user-config.js')
	setUserConfigValue(['tui', value], true, { home: userHome, env: {} })
}
process.stdout.write('done')
