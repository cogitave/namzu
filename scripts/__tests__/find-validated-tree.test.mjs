/**
 * `.github/scripts/find-validated-tree.mjs` answers yes only for a successful,
 * same-repository `ci.yml` run on a pull request or merge group that uploaded
 * `validated-tree-<tree>`, and no to everything else, errors included.
 *
 * `scripts/__tests__/` belongs to no package, so `pnpm -r test` cannot reach
 * this file; both workflows run it in the step named `The two paths onto main
 * run the same gates`. By hand:
 *
 *   node --test scripts/__tests__/find-validated-tree.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { findValidatedTree } from '../../.github/scripts/find-validated-tree.mjs'

const REPO = 'cogitave/namzu'
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)
const NOW = Date.parse('2026-09-22T12:00:00Z')
const API = 'https://api.test'

function artifact(overrides = {}) {
	return {
		id: 11,
		name: `validated-tree-${TREE}`,
		expired: false,
		expires_at: '2026-09-29T12:00:00Z',
		workflow_run: { id: 42, repository_id: 7, head_repository_id: 7, head_sha: 'c'.repeat(40) },
		...overrides,
	}
}

function run(overrides = {}) {
	return {
		id: 42,
		path: '.github/workflows/ci.yml',
		status: 'completed',
		conclusion: 'success',
		event: 'pull_request',
		html_url: `https://github.com/${REPO}/actions/runs/42`,
		repository: { full_name: REPO },
		head_repository: { full_name: REPO },
		...overrides,
	}
}

/**
 * A fetch that answers from a table of URL-prefix → body and records what it
 * was asked. An unknown URL answers 404, which the helper must read as "no".
 */
function mockFetch(routes) {
	const calls = []
	const impl = async (url, init) => {
		calls.push({ url, init })
		for (const [prefix, answer] of routes) {
			if (url.startsWith(prefix)) {
				if (answer instanceof Error) throw answer
				if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) }
				return { ok: true, status: 200, json: async () => answer }
			}
		}
		return { ok: false, status: 404, json: async () => ({}) }
	}
	impl.calls = calls
	return impl
}

function listing(artifacts, total = artifacts.length) {
	return { total_count: total, artifacts }
}

function routesFor({ artifacts = [artifact()], runBody = run(), tree = TREE } = {}) {
	return [
		[`${API}/repos/${REPO}/actions/artifacts?name=validated-tree-${tree}`, listing(artifacts)],
		[`${API}/repos/${REPO}/actions/runs/42`, runBody],
	]
}

async function ask(routes, overrides = {}) {
	const fetch = mockFetch(routes)
	const result = await findValidatedTree({ repo: REPO, tree: TREE, token: 't0k', fetch, apiUrl: API, now: NOW, ...overrides })
	return { result, fetch }
}

describe('find-validated-tree', () => {
	it('answers yes for a successful same-repository ci.yml pull_request run', async () => {
		const { result, fetch } = await ask(routesFor())
		assert.equal(result.validated, true, result.reason)
		assert.equal(result.runId, 42)
		assert.equal(result.runUrl, `https://github.com/${REPO}/actions/runs/42`)
		assert.match(fetch.calls[0].url, /name=validated-tree-a{40}&/)
		assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer t0k')
	})

	it('answers yes for a merge_group run too', async () => {
		const { result } = await ask(routesFor({ runBody: run({ event: 'merge_group' }) }))
		assert.equal(result.validated, true, result.reason)
	})

	it('rejects a run from a fork', async () => {
		const { result } = await ask(routesFor({ runBody: run({ head_repository: { full_name: 'mallory/namzu' } }) }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /mallory\/namzu/)
	})

	it('rejects an artifact whose run has a different head repository id', async () => {
		const fork = artifact({ workflow_run: { id: 42, repository_id: 7, head_repository_id: 99 } })
		const { result, fetch } = await ask(routesFor({ artifacts: [fork] }))
		assert.equal(result.validated, false)
		assert.equal(fetch.calls.length, 1, 'a fork artifact should not even be followed to its run')
	})

	it('rejects a failed run', async () => {
		const { result } = await ask(routesFor({ runBody: run({ conclusion: 'failure' }) }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /failure/)
	})

	it('rejects a run that has not completed', async () => {
		const { result } = await ask(routesFor({ runBody: run({ status: 'in_progress', conclusion: null }) }))
		assert.equal(result.validated, false)
	})

	it('rejects a run of another workflow', async () => {
		const { result } = await ask(routesFor({ runBody: run({ path: '.github/workflows/release.yml' }) }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /release\.yml/)
	})

	it('rejects a workflow whose path only starts with ci.yml', async () => {
		const { result } = await ask(routesFor({ runBody: run({ path: '.github/workflows/ci.yml.evil' }) }))
		assert.equal(result.validated, false)
	})

	it('accepts the documented path@ref form of ci.yml', async () => {
		const { result } = await ask(routesFor({ runBody: run({ path: '.github/workflows/ci.yml@refs/pull/9/merge' }) }))
		assert.equal(result.validated, true, result.reason)
	})

	it('rejects a push-triggered run', async () => {
		const { result } = await ask(routesFor({ runBody: run({ event: 'push' }) }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /push/)
	})

	it('rejects an expired artifact', async () => {
		const { result, fetch } = await ask(routesFor({ artifacts: [artifact({ expired: true })] }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /expired/)
		assert.equal(fetch.calls.length, 1)
	})

	it('rejects an artifact past its expiry time even if not yet flagged expired', async () => {
		const { result } = await ask(routesFor({ artifacts: [artifact({ expires_at: '2026-09-21T00:00:00Z' })] }))
		assert.equal(result.validated, false)
	})

	it('answers no on an API error from the listing', async () => {
		const { result } = await ask([[`${API}/repos/${REPO}/actions/artifacts`, 500]])
		assert.equal(result.validated, false)
		assert.match(result.reason, /500/)
	})

	it('answers no on an API error from the run lookup', async () => {
		const { result } = await ask([[`${API}/repos/${REPO}/actions/artifacts`, listing([artifact()])], [`${API}/repos/${REPO}/actions/runs/42`, 403]])
		assert.equal(result.validated, false)
	})

	it('answers no when fetch itself throws', async () => {
		const { result } = await ask([[`${API}/`, new Error('ECONNRESET')]])
		assert.equal(result.validated, false)
		assert.match(result.reason, /ECONNRESET/)
	})

	it('answers no on a listing of the wrong shape', async () => {
		const { result } = await ask([[`${API}/repos/${REPO}/actions/artifacts`, { artifacts: 'nope' }]])
		assert.equal(result.validated, false)
	})

	it('answers no when only another tree was validated', async () => {
		// The listing is filtered by name server-side; a response carrying another
		// tree's record must still not count.
		const other = artifact({ name: `validated-tree-${OTHER_TREE}` })
		const { result } = await ask([[`${API}/repos/${REPO}/actions/artifacts`, listing([other])], [`${API}/repos/${REPO}/actions/runs/42`, run()]])
		assert.equal(result.validated, false)
		assert.match(result.reason, /named/)
	})

	it('answers no when there is no artifact at all', async () => {
		const { result } = await ask(routesFor({ artifacts: [] }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /no artifact named/)
	})

	it('answers no to a tree sha that is not one, without asking', async () => {
		const { result, fetch } = await ask(routesFor(), { tree: 'HEAD' })
		assert.equal(result.validated, false)
		assert.equal(fetch.calls.length, 0)
	})

	it('answers no without a token', async () => {
		const { result, fetch } = await ask(routesFor(), { token: '' })
		assert.equal(result.validated, false)
		assert.equal(fetch.calls.length, 0)
	})

	it('keeps looking past a disqualified artifact to a qualifying one', async () => {
		const failed = artifact({ id: 10, workflow_run: { id: 41, repository_id: 7, head_repository_id: 7 } })
		const { result } = await ask([
			[`${API}/repos/${REPO}/actions/artifacts`, listing([failed, artifact()])],
			[`${API}/repos/${REPO}/actions/runs/41`, run({ id: 41, conclusion: 'cancelled' })],
			[`${API}/repos/${REPO}/actions/runs/42`, run()],
		])
		assert.equal(result.validated, true, result.reason)
		assert.equal(result.runId, 42)
	})

	it('answers no when more pages exist than it will read and none qualified', async () => {
		const expired = Array.from({ length: 100 }, (_, i) => artifact({ id: i, expired: true }))
		const { result, fetch } = await ask([[`${API}/repos/${REPO}/actions/artifacts`, listing(expired, 10_000)]])
		assert.equal(result.validated, false)
		assert.equal(fetch.calls.length, 5)
	})
})

describe('find-validated-tree as release.yml runs it', () => {
	it('writes skip=false to GITHUB_OUTPUT and exits 0 when the lookup cannot be made', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-validated-tree-'))
		try {
			const output = join(dir, 'out')
			const result = spawnSync(process.execPath, ['.github/scripts/find-validated-tree.mjs', '--repo', REPO, '--tree', TREE], {
				cwd: join(import.meta.dirname, '..', '..'),
				env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_TOKEN: '' },
				encoding: 'utf8',
			})
			assert.equal(result.status, 0, result.stderr)
			assert.match(result.stdout, /every validation gate runs/)
			const written = readFileSync(output, 'utf8')
			assert.match(written, /^skip=false$/m)
			assert.match(written, /^reason=no token/m)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
