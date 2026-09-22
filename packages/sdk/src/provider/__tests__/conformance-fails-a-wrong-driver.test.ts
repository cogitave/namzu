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
const PROVIDERS_DIR = join(HERE, '..', '..', '..', '..', 'providers')

/** Comments carry the docblocks that ARGUE for a zero, so they are not scanned. */
function stripComments(raw: string): string {
	return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every non-test TypeScript source in every provider package. */
function driverSources(): string[] {
	const files: string[] = []
	for (const pkg of readdirSync(PROVIDERS_DIR)) {
		const src = join(PROVIDERS_DIR, pkg, 'src')
		if (!existsSync(src)) continue
		for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
			// `codex.ts` is the file this reaches that a `client.ts`-only scan
			// did not, and it carried one of the six zeros.
			if (entry.parentPath.includes('__tests__') || entry.name.endsWith('.test.ts')) continue
			files.push(join(entry.parentPath, entry.name))
		}
	}
	return files
}

/** The drivers the rate card says bill nothing by construction — local inference. */
function unmeteredPackages(): Set<string> {
	const raw = readFileSync(join(HERE, '..', '..', 'pricing', 'rates.source.json'), 'utf8')
	const source = JSON.parse(raw) as { vendors: { providerId: string; unmetered?: boolean }[] }
	return new Set(
		source.vendors.filter((vendor) => vendor.unmetered === true).map((vendor) => vendor.providerId),
	)
}

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
		retryDefaults: undefined,
		attribution: { kind: 'header' },
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

describe('no driver writes a zero it does not mean', () => {
	it('finds no literal contextWindow: 0 or maxOutputTokens: 0 in any driver', () => {
		// Scanned, not asserted through the suite, and the difference matters.
		// The suite's own rule reads `listModels` — which for every in-tree
		// driver needs a live service, so it returns early and asserts
		// nothing in CI. Verified by putting a zero back and watching the
		// driver's conformance run stay green.
		//
		// This scan does not depend on reaching anything, so it is the half
		// that actually holds the line.
		const offenders: string[] = []

		for (const pkg of readdirSync(PROVIDERS_DIR)) {
			const client = join(PROVIDERS_DIR, pkg, 'src', 'client.ts')
			if (!existsSync(client)) continue
			const code = stripComments(readFileSync(client, 'utf8'))
			if (/\b(contextWindow|maxOutputTokens):\s*0\b/.test(code)) offenders.push(pkg)
		}

		expect(offenders).toEqual([])
	})

	it('finds no price defaulted to zero in any driver', () => {
		// The class that actually shipped. Six drivers wrote `0` for a rate they
		// had never learned, and `?? 0` is how most of them said it — a shape
		// that READS as "fall back to zero" and BEHAVES as "assert this model is
		// free". A price of zero is a claim about a bill, so a default that
		// produces one makes that claim on the reader's behalf.
		//
		// No exemption applies here, and that is the point of splitting it from
		// the literal scan below. A driver that is genuinely unmetered does not
		// need a default: it states `0` because it knows it, not because a
		// lookup came back empty.
		//
		// The field name is matched with or without a `:` after it, and the
		// first draft required the colon. That draft was tested by putting
		// openrouter's `?? '0'` back and it passed — because the reintroduction
		// does not have to be an object literal. `const inputPrice =
		// pricePerMillion(m.pricing?.prompt ?? '0')` is the same defect one line
		// up, and the colon requirement read straight past it.
		const offenders: string[] = []
		for (const file of driverSources()) {
			const code = stripComments(readFileSync(file, 'utf8'))
			if (/\b(inputPrice|outputPrice)\b[^\n]*(\?\?|\|\|)\s*['"]?0['"]?/.test(code)) {
				offenders.push(file.slice(PROVIDERS_DIR.length + 1))
			}
		}
		expect(offenders).toEqual([])
	})

	it('finds no literal zero price outside a driver that is unmetered', () => {
		// A literal `0` is not decidable from the source alone — it is either a
		// claim ("this bills nothing") or a placeholder ("I never found out"),
		// and the two are identical text. So this reads the claim from the one
		// place the repo already records it, `rates.source.json`'s
		// `unmetered: true`, whose own prose is the argument this change
		// extends: local inference "is priced at zero, which is KNOWN-free and
		// therefore distinct from unknown".
		//
		// The generated Zen catalogue is exempt by name. Its zeros come from a
		// reviewed source through rules that refuse any model the page neither
		// prices nor names free — `@namzu/zen`'s `src/catalogue/derive.ts`,
		// which renders the bundled snapshot and refreshes it at run time, with
		// its own tests and the generator's holding that line — a stronger
		// guarantee than a text scan could give, and one this scan would only
		// misreport as a defect.
		//
		// What this does NOT reach: a driver that hardcodes a literal zero it
		// should have derived. That is syntactically indistinguishable from
		// ollama's honest one, and no scan can separate them. The half that
		// holds is the default above, because a derived price cannot be
		// reintroduced without one.
		const unmetered = unmeteredPackages()
		const offenders: string[] = []

		for (const file of driverSources()) {
			const relative = file.slice(PROVIDERS_DIR.length + 1)
			const pkg = relative.slice(0, relative.indexOf('/'))
			if (unmetered.has(pkg)) continue
			if (relative === 'zen/src/models.ts') continue
			const code = stripComments(readFileSync(file, 'utf8'))
			// `(?![\d.])` so `0.8` is a rate and not a zero. Without it the
			// scan reported bedrock's Nova Pro row — a real published price —
			// as a placeholder, which is the failure mode of a text scan that
			// is too eager, and the reason the default above carries the weight.
			if (/\b(inputPrice|outputPrice)\s*:\s*0(?![\d.])/.test(code)) offenders.push(relative)
		}

		expect(offenders).toEqual([])
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
