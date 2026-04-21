#!/usr/bin/env node
/**
 * Test-presence gate for @namzu/sdk.
 *
 * Reads `packages/sdk/coverage-config.json`. Every folder directly under
 * `packages/sdk/src/` must be classified into exactly one of three lists:
 *
 *   - `required`       — must contain at least one `*.test.ts` file recursively.
 *   - `baselineExempt` — current zero-tested modules; not yet required. A
 *                        module graduates by moving from this list to
 *                        `required` in the same commit that adds its tests
 *                        (each phase of ses_006-test-coverage-sprint does
 *                        exactly this for one module).
 *   - `exempt`         — declarative folders (`types`, `constants`, etc.)
 *                        that do not need behavior tests.
 *
 * Fails if:
 *   - Any folder under `src/` is missing from all three lists (forces a
 *     decision when a new module lands).
 *   - Any `required` folder has zero `*.test.ts` files beneath it.
 *   - A folder appears in more than one list.
 *
 * This is the structural half of the coverage gate; the per-module floor
 * check lives in `check-sdk-module-coverage.mjs`.
 *
 * Convention: "enumerate what counts, don't infer." Mirrors
 * `.github/scripts/verify-public-surface.mjs`. See
 * `docs.local/conventions/public-surface-buckets.md` for the same pattern
 * applied to the public API.
 *
 * Non-bypassable by design (ses_006 Q7); there is no env-var escape hatch.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const sdkRoot = join(repoRoot, 'packages', 'sdk')
const srcRoot = join(sdkRoot, 'src')
const configPath = join(sdkRoot, 'coverage-config.json')

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const { required, baselineExempt, exempt } = config.modules

function listImmediateDirs(root) {
	return readdirSync(root).filter((name) => {
		const full = join(root, name)
		try {
			return statSync(full).isDirectory()
		} catch {
			return false
		}
	})
}

function hasTestFileRecursive(root) {
	const entries = readdirSync(root)
	for (const entry of entries) {
		const full = join(root, entry)
		let stat
		try {
			stat = statSync(full)
		} catch {
			continue
		}
		if (stat.isDirectory()) {
			if (hasTestFileRecursive(full)) return true
		} else if (entry.endsWith('.test.ts')) {
			return true
		}
	}
	return false
}

const srcDirs = listImmediateDirs(srcRoot).sort()
const allClassified = [...required, ...baselineExempt, ...exempt]

let failed = false

// 1. Every src/ folder must be classified exactly once.
const classifyCount = new Map()
for (const name of allClassified) {
	classifyCount.set(name, (classifyCount.get(name) ?? 0) + 1)
}

const duplicates = [...classifyCount.entries()].filter(([, n]) => n > 1)
if (duplicates.length > 0) {
	console.error('\n✗ coverage-config.json classification conflicts:')
	for (const [name, n] of duplicates) {
		console.error(`  - "${name}" appears in ${n} lists (must appear in exactly one)`)
	}
	failed = true
}

const unclassified = srcDirs.filter((name) => !classifyCount.has(name))
if (unclassified.length > 0) {
	console.error('\n✗ src/ folders missing from coverage-config.json:')
	for (const name of unclassified) {
		console.error(`  - packages/sdk/src/${name}/ (add to required | baselineExempt | exempt)`)
	}
	failed = true
}

const ghostClassifications = allClassified.filter(
	(name) => !srcDirs.includes(name) && name !== '__tests__',
)
if (ghostClassifications.length > 0) {
	console.error('\n✗ coverage-config.json lists folders that do not exist under src/:')
	for (const name of ghostClassifications) {
		console.error(`  - "${name}" (remove from config or create src/${name}/)`)
	}
	failed = true
}

// 2. Every required folder must contain at least one *.test.ts file.
const requiredWithoutTests = []
for (const name of required) {
	const full = join(srcRoot, name)
	try {
		statSync(full)
	} catch {
		continue
	}
	if (!hasTestFileRecursive(full)) requiredWithoutTests.push(name)
}

if (requiredWithoutTests.length > 0) {
	console.error('\n✗ required modules missing tests:')
	for (const name of requiredWithoutTests) {
		console.error(`  - packages/sdk/src/${name}/ has no *.test.ts file`)
	}
	failed = true
}

// 3. Friendly summary on the happy path.
if (!failed) {
	console.log(`✓ test-presence gate passed`)
	console.log(`  required:       ${required.length} modules, all have tests`)
	console.log(`  baselineExempt: ${baselineExempt.length} modules (future coverage debt)`)
	console.log(`  exempt:         ${exempt.length} declarative folders`)
}

process.exit(failed ? 1 : 0)
