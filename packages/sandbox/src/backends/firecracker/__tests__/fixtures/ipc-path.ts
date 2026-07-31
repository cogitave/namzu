import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * A local IPC address Node can actually `listen()` on, for the current OS.
 *
 * These suites bind a loopback agent over a Unix domain socket in a temp
 * directory. Windows supports `AF_UNIX` at the OS level, but Node's `net`
 * server does not bind filesystem sockets there — it wants a **named
 * pipe**, so every one of these tests failed with
 * `listen EACCES: permission denied …\agent.sock` and the whole
 * `@namzu/sandbox` suite has been red for Windows contributors.
 *
 * The transport under test is address-agnostic: it is handed a path and
 * connects to it. So the fix belongs in the fixture, not the driver.
 */
export function localIpcPath(workDir: string, name = 'agent'): string {
	if (process.platform === 'win32') {
		// Named pipes are not filesystem entries, so the temp dir cannot
		// namespace them — a uuid keeps concurrent test files apart.
		return `\\\\.\\pipe\\namzu-${name}-${randomUUID()}`
	}
	return join(workDir, `${name}.sock`)
}

/**
 * True when the socket address lives on disk and can be cleaned up with
 * the temp directory. Named pipes disappear with the process that owns
 * them, so there is nothing to unlink.
 */
export const IPC_IS_FILESYSTEM_PATH = process.platform !== 'win32'
