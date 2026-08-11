import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { StdioTransport, buildChildEnv } from '../stdio.js'

/**
 * A stdio server used to be spawned with `{ ...process.env, ...config.env }`.
 *
 * Measured before the change, through this same transport: the child received
 * 119 environment variables on a developer machine, including a secret planted
 * in the parent for the probe. A server that needs one token was handed every
 * credential the host held, and nothing in its config said so — the grant was
 * invisible because it was total.
 *
 * These tests assert on the ENVIRONMENT THE CHILD RECEIVES. A test that only
 * checked `inheritEnv` was accepted by the config would have passed against the
 * version this replaces, which is the shape of check that let this ship.
 */

const SECRET = 'NAMZU_TEST_PARENT_SECRET'
const TOKEN = 'NAMZU_TEST_GRANTED_TOKEN'

function parentEnv(): NodeJS.ProcessEnv {
	return {
		PATH: '/usr/bin',
		HOME: '/home/someone',
		[SECRET]: 'sk-live-must-not-travel',
		[TOKEN]: 'granted-value',
	}
}

describe('the environment a stdio server is handed', () => {
	it('carries the plumbing a process needs to run at all', () => {
		const env = buildChildEnv({}, parentEnv())

		// Not hardening, and dropping it would only break the spawn: a child
		// with no PATH cannot resolve its own interpreter.
		expect(env.PATH).toBe('/usr/bin')
		expect(env.HOME).toBe('/home/someone')
	})

	it('does not carry a parent secret nobody named', () => {
		const env = buildChildEnv({}, parentEnv())

		expect(env).not.toHaveProperty(SECRET)
	})

	it('carries a variable the config names, and still not the one it does not', () => {
		const env = buildChildEnv({ inheritEnv: [TOKEN] }, parentEnv())

		expect(env[TOKEN]).toBe('granted-value')
		// The half that makes the grant mean something. Naming one variable
		// must not re-open the rest.
		expect(env).not.toHaveProperty(SECRET)
	})

	it('leaves a named-but-unset variable absent rather than empty', () => {
		const env = buildChildEnv({ inheritEnv: ['NAMZU_TEST_NOT_SET'] }, parentEnv())

		// An empty string tells a server it HAS a credential. Absent is the
		// truth, and it is what a server's own `if (!token)` is written for.
		expect(env).not.toHaveProperty('NAMZU_TEST_NOT_SET')
	})

	it('lets a literal value win over both an inherited one and the base', () => {
		const env = buildChildEnv(
			{ inheritEnv: [TOKEN], env: { [TOKEN]: 'literal-wins', PATH: '/opt/bin' } },
			parentEnv(),
		)

		expect(env[TOKEN]).toBe('literal-wins')
		expect(env.PATH).toBe('/opt/bin')
	})
})

describe('the transport actually spawns with that environment', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	/**
	 * Reachability is its own property. Every case above proves the helper is
	 * right and none of them proves `connect()` calls it — which is exactly the
	 * gap that would leave the spawn passing the whole parent environment while
	 * a green suite reported the filter working.
	 */
	it('gives a real child the plumbing and not the parent secret', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-stdio-env-'))
		workdirs.push(dir)
		const server = join(dir, 'report-env.mjs')
		await writeFile(
			server,
			[
				'const answer = {',
				'  hasSecret: process.env.NAMZU_TEST_PARENT_SECRET !== undefined,',
				'  hasToken: process.env.NAMZU_TEST_GRANTED_TOKEN !== undefined,',
				'  hasPath: process.env.PATH !== undefined,',
				'}',
				'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer }) + "\\n")',
			].join('\n'),
			'utf-8',
		)

		process.env[SECRET] = 'sk-live-must-not-travel'
		process.env[TOKEN] = 'granted-value'

		const transport = new StdioTransport({
			type: 'stdio',
			command: process.execPath,
			args: [server],
			inheritEnv: [TOKEN],
		})

		const reported = new Promise<Record<string, boolean>>((resolve) => {
			transport.onMessage((message) => {
				const result = (message as { result?: Record<string, boolean> }).result
				if (result) resolve(result)
			})
		})

		await transport.connect()
		const answer = await reported
		await transport.close()
		process.env[SECRET] = undefined
		process.env[TOKEN] = undefined

		expect(answer.hasPath).toBe(true)
		expect(answer.hasToken).toBe(true)
		expect(answer.hasSecret).toBe(false)
	})
})
