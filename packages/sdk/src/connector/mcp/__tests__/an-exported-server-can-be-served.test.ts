import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `MCPServer` was public and the only transport that can run it was not.
 *
 * A consumer could construct the server, register providers on it, and
 * then have no supported way to serve it: `ServerStdioTransport` reached
 * `connector/mcp/index.ts` and stopped there, because `connector/index.ts`
 * hand-listed names from the LEAF modules and that list had drifted from
 * the barrel's. Two lists of the same thing, and the second one silently
 * shorter.
 *
 * Both halves are pinned here. The names have to be reachable from the
 * package root, and the barrel has to stay the single source they come
 * from — because re-adding a leaf import is exactly how the lists diverged
 * the first time, and it does not look like a mistake in review.
 */

const CONNECTOR_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts')

describe('a server the package exports can be served by a transport it exports', () => {
	it('reaches both halves of the pair from the package root', async () => {
		// Through `public-runtime.ts`, the entry a consumer actually imports —
		// not through the internal barrel, which was never the broken half.
		const sdk = await import('../../../public-runtime.js')

		expect(typeof sdk.MCPServer, 'MCPServer').toBe('function')
		expect(typeof sdk.ServerStdioTransport, 'ServerStdioTransport').toBe('function')
	})

	it('exposes the policy helpers whose types it already had', async () => {
		// `MCPToolPolicy` and friends were reachable as types with no function
		// to apply them — a shape a consumer can describe and not use.
		const sdk = await import('../../../public-runtime.js')

		for (const name of [
			'applyToolPolicy',
			'applyNamePolicy',
			'diffTools',
			'hasDrift',
			'toolsHash',
		]) {
			expect(typeof (sdk as Record<string, unknown>)[name], name).toBe('function')
		}
	})

	it('keeps connector/index.ts sourcing its MCP names from the one barrel', () => {
		// The structural half. A leaf import here compiles, passes every other
		// test, and re-opens the divergence — so it is asserted rather than
		// left to review.
		const source = readFileSync(CONNECTOR_INDEX, 'utf8')
		const leafImports = source
			.split('\n')
			.filter((line) => /from '\.\/mcp\/(?!index\.js)/.test(line))

		expect(leafImports, 'connector/index.ts re-imports an mcp leaf module').toEqual([])
		expect(source).toContain("} from './mcp/index.js'")
	})
})
