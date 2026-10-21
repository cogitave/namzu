import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { describeCodeAnalysis } from '../../../doctor/checks/code-analysis.js'
import {
	codeAnalysisCacheDir,
	codeAnalysisSelfTest,
	createLazyCodeAnalysis,
	parsingChildScript,
} from '../provider.js'

/**
 * The CLI's half: nothing happens until the first call, and the first call
 * puts the index under the Namzu home. The index itself is `@namzu/analysis`'s
 * to prove.
 */

const dirs: string[] = []
const scratch = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createLazyCodeAnalysis', () => {
	it('creates nothing until a call is made, and disposing an unused one is free', async () => {
		const home = scratch('namzu-lazy-home-')
		const provider = createLazyCodeAnalysis(home)
		expect(existsSync(join(home, 'cache'))).toBe(false)
		await provider.dispose()
		expect(existsSync(join(home, 'cache'))).toBe(false)
	})

	it('indexes under <home>/cache/analysis on the first call and persists there', async () => {
		const home = scratch('namzu-lazy-home-')
		const project = scratch('namzu-lazy-project-')
		mkdirSync(join(project, 'src'))
		writeFileSync(join(project, 'src', 'a.js'), 'function a() { return "cited-literal" }\n')

		const provider = createLazyCodeAnalysis(home)
		const hits = await provider.findLiteral({ root: project, text: 'cited-literal' })
		expect(hits.kind).toBe('ok')
		if (hits.kind === 'ok') {
			expect(hits.value.total).toBe(1)
			expect(hits.value.items[0]?.function?.name).toBe('a')
		}
		await provider.dispose()

		const cache = codeAnalysisCacheDir(home)
		expect(existsSync(cache)).toBe(true)
		expect(readdirSync(cache).some((f) => f.endsWith('.sqlite'))).toBe(true)
	})

	it('falls back to memory when the cache directory cannot be made, and still answers', async () => {
		const home = scratch('namzu-lazy-home-')
		const project = scratch('namzu-lazy-project-')
		writeFileSync(join(project, 'a.js'), 'function a() { return "no-cache-literal" }\n')
		// `cache` is a file, so the directory beneath it cannot exist.
		writeFileSync(join(home, 'cache'), 'in the way')

		const provider = createLazyCodeAnalysis(home)
		const r = await provider.index({ root: project })
		expect(r.kind).toBe('ok')
		if (r.kind === 'ok') expect(r.value.persisted).toBe(false)
		await provider.dispose()
	})
})

describe('the parsing child in a packaged CLI', () => {
	it('is the bundle entry beside the running bundle, and absent when running from source', () => {
		// From source there is no dist/analysis-host.js next to this module, so the
		// package forks its own build; a packaged CLI finds its own entry.
		expect(parsingChildScript()).toBeUndefined()
	})

	it('runs a one-file index through a child process, and the doctor check reports it', async () => {
		const result = await codeAnalysisSelfTest()
		expect(result).toMatchObject({ ok: true })
		const check = await describeCodeAnalysis()
		expect(check.status).toBe('pass')
		expect(check.message).toContain('child process')
	})
})
