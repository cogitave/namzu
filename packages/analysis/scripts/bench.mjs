#!/usr/bin/env node
// Opt-in benchmark for @namzu/analysis. Not run by CI: it indexes large trees and the
// numbers depend on the machine.
//
//   pnpm --filter @namzu/analysis build
//   node packages/analysis/scripts/bench.mjs --root <dir> [--root <dir>...] [--runs 5] [--no-fts] [--edit] [--out result.json]
//
// With no --root it indexes every packages/*/src and packages/providers/*/src of this repository,
// one root each, and prints a total line. Each root gets a fresh cache
// directory, so "cold" is truly cold. Reported per root:
//
//   cold index   wall time of the first index, files, rows, database size, peak RSS so far
//   warm index   a second index with nothing changed (stat only)
//   add/remove   with --edit only: one file added to the root and refreshed, then removed
//   queries      median of --runs calls each: find_literal, enclosing_function, callers_of
//
// Peak RSS is the process high-water mark, so run one root per process when comparing roots.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCodeAnalysisProvider } from '../dist/index.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const values = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const runs = Number(values('--runs')[0] ?? 5)
const out = values('--out')[0]
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function repoSources() {
	// Every package's src directory, as its own root, the way a session in one package sees it.
	const dirs = []
	for (const group of ['packages', 'packages/providers']) {
		const base = join(repo, group)
		for (const name of readdirSync(base)) {
			const src = join(base, name, 'src')
			try {
				if (statSync(src).isDirectory()) dirs.push(src)
			} catch {
				// Not a package with a src directory.
			}
		}
	}
	return dirs
}

const roots = values('--root').length > 0 ? values('--root') : repoSources()
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const ms = (n) => Math.round(n * 10) / 10
const mb = (n) => Math.round((n / 1048576) * 10) / 10

async function time(fn) {
	const t = performance.now()
	const value = await fn()
	return { ms: performance.now() - t, value }
}

function dirSize(dir) {
	let total = 0
	for (const name of readdirSync(dir)) total += statSync(join(dir, name)).size
	return total
}

const report = []
for (const root of roots) {
	const cache = mkdtempSync(join(tmpdir(), 'namzu-analysis-bench-'))
	const provider = createCodeAnalysisProvider({
		cacheDir: cache,
		...(flag('--no-fts') ? { substringIndex: 'off' } : {}),
	})
	const result = { root, node: process.version, fts: !flag('--no-fts') }

	const cold = await time(() => provider.index({ root }))
	if (cold.value.kind !== 'ok') throw new Error(JSON.stringify(cold.value))
	const s = cold.value.value
	Object.assign(result, {
		coldIndexMs: Math.round(cold.ms),
		files: s.files,
		skippedReasons: s.skippedReasons,
		functions: s.functions,
		strings: s.strings,
		calls: s.calls,
		dbMB: mb(dirSize(cache)),
		peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
	})

	result.warmIndexMs = Math.round((await time(() => provider.index({ root }))).ms)

	// A literal that exists, taken from the index itself, so the query is a hit.
	const sample = await provider.findLiteral({ root, text: 'a', limit: 1 })
	const probe = sample.kind === 'ok' ? sample.value.items.find((i) => i.value.length >= 12) ?? sample.value.items[0] : undefined
	const needle = (probe?.value ?? 'error').slice(0, 12)

	const samples = { find_literal: [], enclosing_function: [], callers_of: [] }
	let hit
	for (let i = 0; i < runs; i++) {
		const r = await time(() => provider.findLiteral({ root, text: needle, limit: 50 }))
		samples.find_literal.push(r.ms)
		hit = r.value.kind === 'ok' ? r.value.value.items[0] : undefined
	}
	if (hit) {
		for (let i = 0; i < runs; i++) {
			samples.enclosing_function.push(
				(await time(() => provider.enclosingFunction({ root, path: hit.path, line: hit.line, column: hit.column, maxChars: 4000 }))).ms,
			)
		}
		const name = hit.function?.name
		if (name) {
			for (let i = 0; i < runs; i++) {
				samples.callers_of.push((await time(() => provider.callersOf({ root, name, scope: 'workspace', limit: 50 }))).ms)
			}
		}
	}
	result.queryMedianMs = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.length ? ms(median(v)) : null]))
	result.needle = needle

	// With --edit: add one file, refresh, remove it, refresh. The tree is left as it was
	// found. Off by default because it writes into the root being measured.
	if (flag('--edit')) {
		const added = join(root, '.namzu-bench-edit.js')
		writeFileSync(added, 'export function benchEdit() { return "bench-edit-literal" }\n')
		const add = await time(() => provider.index({ root }))
		result.addOneFileMs = Math.round(add.ms)
		result.addParsed = add.value.kind === 'ok' ? add.value.value.files.parsed : null
		rmSync(added, { force: true })
		const drop = await time(() => provider.index({ root }))
		result.removeOneFileMs = Math.round(drop.ms)
	}
	await provider.dispose()
	rmSync(cache, { recursive: true, force: true })
	report.push(result)
	console.log(JSON.stringify(result))
}
if (report.length > 1) {
	const sum = (f) => report.reduce((a, r) => a + f(r), 0)
	console.log(
		JSON.stringify({
			total: true,
			roots: report.length,
			files: sum((r) => r.files.indexed),
			functions: sum((r) => r.functions),
			strings: sum((r) => r.strings),
			calls: sum((r) => r.calls),
			coldIndexMs: sum((r) => r.coldIndexMs),
			warmIndexMs: sum((r) => r.warmIndexMs),
			dbMB: Math.round(sum((r) => r.dbMB) * 10) / 10,
			peakRssMB: Math.max(...report.map((r) => r.peakRssMB)),
		}),
	)
}
if (out) {
	mkdirSync(dirname(resolve(out)), { recursive: true })
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
}
