import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { LLMProvider } from '../../types/provider/interface.js'
import { defineProviderDriverConformance } from '../conformance.js'

/**
 * A conformance suite that cannot fail is a list of opinions.
 *
 * The suite is driven here with RECORDING `describe`/`it`/`expect`, so the
 * whole contract runs as ordinary code against a deliberately wrong
 * driver. That is the property separating this from decoration, and it is
 * the same one `conformance-fails-a-wrong-store.test.ts` establishes for
 * the checkpoint store.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Runs the suite as code and returns the names of the cases that failed. */
async function runSuite(makeProvider: () => LLMProvider, registryType = 'good'): Promise<string[]> {
	const failures: string[] = []
	const cases: { name: string; body: () => Promise<void> }[] = []

	defineProviderDriverConformance({
		describe: (_name, body) => body(),
		it: (name, body) => cases.push({ name, body }),
		expect: (actual) => ({
			toBe(expected) {
				if (actual !== expected)
					throw new Error(`expected ${String(actual)} to be ${String(expected)}`)
			},
			toEqual(expected) {
				if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('not equal')
			},
			toBeGreaterThan(expected) {
				if (!(typeof actual === 'number' && actual > expected)) throw new Error('not greater')
			},
			toMatch(expected) {
				if (typeof actual !== 'string' || !expected.test(actual)) throw new Error('no match')
			},
		}),
		label: 'under test',
		registryType,
		makeProvider,
	})

	for (const testCase of cases) {
		try {
			await testCase.body()
		} catch {
			failures.push(testCase.name)
		}
	}
	return failures
}

function goodDriver(id = 'good'): LLMProvider {
	return {
		id,
		name: 'Good Driver',
		capabilities: { supportsTools: true, supportsStreaming: true, supportsFunctionCalling: true },
		// biome-ignore lint/correctness/useYield: the contract asserts the shape, not a stream
		async *chatStream() {},
	} as unknown as LLMProvider
}

describe('the driver contract fails a driver that breaks it', () => {
	it('catches an id that does not match the registry string', async () => {
		// The failure that resolves through one call path and not the other:
		// a chain member names the registry type, a lookup uses `id`.
		const failures = await runSuite(() => goodDriver('mismatched'), 'good')

		expect(failures).toContain('has an id equal to the string it is registered under')
	})

	it('catches an empty name', async () => {
		expect(await runSuite(() => ({ ...goodDriver(), name: '' }) as LLMProvider)).toContain(
			'has a non-empty id and name',
		)
	})

	it('catches a capabilities record that is present and malformed', async () => {
		// Absent is legal — it resolves to the permissive default, which is
		// what every driver did before the field existed. Present and wrong
		// reaches the runtime as "supports nothing" and silently strips the
		// tool surfaces from the prompt.
		expect(
			await runSuite(
				() =>
					({ ...goodDriver(), capabilities: { supportsTools: 'yes' } }) as unknown as LLMProvider,
			),
		).toContain('declares capabilities honestly or not at all')
	})

	it('passes a driver that meets it, so the failures above mean something', async () => {
		// Without this the tests above pass against a suite that fails
		// everything, which is the other way a conformance suite goes wrong.
		expect(await runSuite(() => goodDriver())).toEqual([])
	})
})

describe('the suite ships no test framework', () => {
	it('imports no runner', () => {
		// The property that lets the SDK publish this. An accidental
		// `import { describe } from 'vitest'` compiles, passes every test
		// here, and adds a dependency to a package a consumer installs.
		// Comments stripped FIRST. The suite's own docblock shows a consuming
		// example that imports `vitest` — so a bare scan of the file fails
		// precisely because the usage is documented. Exactly the shape that
		// caught `drain.ts`'s `while (true)`.
		const raw = readFileSync(join(HERE, '..', 'conformance.ts'), 'utf8')
		const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
		const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string)

		for (const runner of ['vitest', 'jest', 'mocha', 'node:test', '@jest/globals']) {
			expect(specifiers.includes(runner)).toBe(false)
		}
	})
})

describe('every driver package runs the contract', () => {
	it('leaves no provider package without a conformance test', () => {
		// The seventh-driver hole, closed mechanically. Adding an eighth
		// package without the suite fails here rather than being noticed by
		// whoever next reads the directory.
		const providersDir = join(HERE, '..', '..', '..', '..', 'providers')
		const missing: string[] = []

		for (const pkg of readdirSync(providersDir)) {
			const client = join(providersDir, pkg, 'src', 'client.ts')
			if (!existsSync(client)) continue
			if (!existsSync(join(providersDir, pkg, 'src', '__tests__', 'conformance.test.ts'))) {
				missing.push(pkg)
			}
		}

		expect(missing).toEqual([])
	})
})
