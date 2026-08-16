import type { Sandbox } from '../../types/sandbox/index.js'

/**
 * The editor's buffers, as the filesystem the agent sees.
 *
 * The concrete problem: a user has unsaved changes open. The agent reads the
 * file from disk, sees a version nobody is looking at, and edits THAT — so
 * the model's patch is computed against text the user already replaced, and
 * applying it either conflicts or silently reverts their work.
 *
 * A client that declares the filesystem capability is telling this agent
 * that disk may be stale and that it can answer for the live content. So
 * reads and writes go to the client and everything else is untouched.
 *
 * **A decorator, not a `Sandbox` of its own.** A sandbox is an execution
 * boundary as much as a filesystem — `exec`, `destroy`, `rootDir`, a network
 * policy — and a client-backed object that implemented only the file methods
 * would take `bash` away from a session that had it. Every other member
 * delegates, and this file names only the two it replaces.
 */

/** What the client can answer, once it has declared the capability. */
export interface AcpClientFilesystem {
	readTextFile(path: string): Promise<string>
	writeTextFile(path: string, content: string): Promise<void>
}

/**
 * Wrap `inner` so file reads and writes ask the client.
 *
 * Returns `inner` unchanged when there is no client filesystem, so a caller
 * does not have to branch: the absence of the capability is the ordinary
 * case and it should not produce a different code path at every call site.
 */
export function clientBackedSandbox(
	inner: Sandbox,
	client: AcpClientFilesystem | undefined,
): Sandbox {
	if (!client) return inner

	return new Proxy(inner, {
		get(target, property, receiver) {
			if (property === 'readFile') {
				return async (path: string): Promise<Buffer> =>
					Buffer.from(await client.readTextFile(path), 'utf-8')
			}
			if (property === 'writeFile') {
				return async (path: string, content: string | Buffer): Promise<void> => {
					await client.writeTextFile(
						path,
						typeof content === 'string' ? content : content.toString('utf-8'),
					)
				}
			}
			// A Proxy rather than a spread, so a member added to `Sandbox` after
			// this file was written still reaches the real sandbox. A spread
			// copies what existed the day it was written and silently drops the
			// rest — the same defect as a hand-listed re-export.
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}
