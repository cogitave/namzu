/**
 * `.github/scripts/find-validated-tree.mjs` answers yes only for a successful,
 * same-repository `ci.yml` run on a pull request or merge group that uploaded
 * `validated-tree-<tree>` with a GitHub-signed OIDC token showing it executed
 * the `ci.yml` the pushed commit carries, merged into `main`, on that tree,
 * and no to everything else, errors included. The keys here are generated per
 * run; the issuer and its key set are mocked like the API.
 *
 * `scripts/__tests__/` belongs to no package, so `pnpm -r test` cannot reach
 * this file; both workflows run it in the step named `The two paths onto main
 * run the same gates`. By hand:
 *
 *   node --test scripts/__tests__/find-validated-tree.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { deflateRawSync } from 'node:zlib'

import { findValidatedTree, readZipEntry } from '../../.github/scripts/find-validated-tree.mjs'

const REPO = 'cogitave/namzu'
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)
const HEAD_SHA = 'c'.repeat(40)
const CI_BLOB = 'd'.repeat(40)
const FORGED_BLOB = 'e'.repeat(40)
const MERGE_SHA = '1'.repeat(40)
const NOW = Date.parse('2026-09-22T12:00:00Z')
const API = 'https://api.test'
const ISSUER = 'https://oidc.test'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }

/** The claims GitHub puts in a pull_request run's token, for run 42. */
function claims(overrides = {}) {
	return {
		iss: ISSUER,
		aud: 'namzu-validated-tree',
		sub: `repo:${REPO}:pull_request`,
		repository: REPO,
		run_id: '42',
		event_name: 'pull_request',
		ref: 'refs/pull/9/merge',
		base_ref: 'main',
		head_ref: 'feature',
		sha: MERGE_SHA,
		workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/pull/9/merge`,
		workflow_sha: MERGE_SHA,
		exp: Math.floor(NOW / 1000) - 3600 * 24,
		...overrides,
	}
}

function jwt(body = claims(), { key = privateKey, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' } } = {}) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
	const signing = `${encode(header)}.${encode(body)}`
	return `${signing}.${sign('RSA-SHA256', Buffer.from(signing), key).toString('base64url')}`
}

/** A zip of `entries` ([name, content, method?]), as upload-artifact would serve it. */
function zip(entries) {
	const locals = []
	const centrals = []
	let offset = 0
	for (const [name, content, method = 8] of entries) {
		const raw = Buffer.from(content)
		const data = method === 8 ? deflateRawSync(raw) : raw
		const nameBytes = Buffer.from(name)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(method, 8)
		local.writeUInt32LE(data.length, 18)
		local.writeUInt32LE(raw.length, 22)
		local.writeUInt16LE(nameBytes.length, 26)
		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(method, 10)
		central.writeUInt32LE(data.length, 20)
		central.writeUInt32LE(raw.length, 24)
		central.writeUInt16LE(nameBytes.length, 28)
		central.writeUInt32LE(offset, 42)
		locals.push(local, nameBytes, data)
		centrals.push(central, nameBytes)
		offset += 30 + nameBytes.length + data.length
	}
	const directory = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, directory, end])
}

function record(token = jwt()) {
	return zip([
		['validated-tree.json', JSON.stringify({ tree: TREE, run_id: '42' })],
		['validated-tree.jwt', token],
	])
}

function artifact(overrides = {}) {
	return {
		id: 11,
		name: `validated-tree-${TREE}`,
		expired: false,
		expires_at: '2026-09-29T12:00:00Z',
		workflow_run: { id: 42, repository_id: 7, head_repository_id: 7, head_sha: HEAD_SHA },
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
		head_sha: HEAD_SHA,
		html_url: `https://github.com/${REPO}/actions/runs/42`,
		repository: { full_name: REPO },
		head_repository: { full_name: REPO },
		// What the API returns once the PR has merged: only open PRs are listed.
		pull_requests: [],
		...overrides,
	}
}

/**
 * A fetch that answers from a table of URL-prefix → body and records what it
 * was asked. A Buffer answers as bytes; an unknown URL answers 404, which the
 * helper must read as "no".
 */
function mockFetch(routes) {
	const calls = []
	const impl = async (url, init) => {
		calls.push({ url, init })
		for (const [prefix, answer] of routes) {
			if (url.startsWith(prefix)) {
				if (answer instanceof Error) throw answer
				if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) }
				if (Buffer.isBuffer(answer)) {
					return { ok: true, status: 200, arrayBuffer: async () => answer.buffer.slice(answer.byteOffset, answer.byteOffset + answer.length) }
				}
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

function ciFile(sha = CI_BLOB) {
	return { type: 'file', path: '.github/workflows/ci.yml', sha }
}

const LIST = `${API}/repos/${REPO}/actions/artifacts?`

/**
 * What the run executed, as the API tells it: the artifact's archive, the
 * issuer's keys, the ci.yml blob at the token's workflow commit, and the tree
 * of the commit it checked out.
 */
function executed({ archive = record(), sha = MERGE_SHA, blob = CI_BLOB, tree = TREE, artifactId = 11 } = {}) {
	return [
		[`${API}/repos/${REPO}/actions/artifacts/${artifactId}/zip`, archive],
		[`${ISSUER}/.well-known/jwks`, JWKS],
		[`${API}/repos/${REPO}/contents/.github/workflows/ci.yml?ref=${sha}`, typeof blob === 'string' ? ciFile(blob) : blob],
		[`${API}/repos/${REPO}/git/commits/${sha}`, typeof tree === 'string' ? { sha, tree: { sha: tree } } : tree],
	]
}

function routesFor({ artifacts = [artifact()], runBody = run(), tree = TREE, ran = {} } = {}) {
	return [
		[`${LIST}name=validated-tree-${tree}`, listing(artifacts)],
		[`${API}/repos/${REPO}/actions/runs/42`, runBody],
		...executed(ran),
	]
}

async function ask(routes, overrides = {}) {
	const fetch = mockFetch(routes)
	const result = await findValidatedTree({
		repo: REPO,
		tree: TREE,
		ciBlob: CI_BLOB,
		token: 't0k',
		fetch,
		apiUrl: API,
		oidcIssuer: ISSUER,
		now: NOW,
		...overrides,
	})
	return { result, fetch }
}

const mergeGroupClaims = claims({
	sub: `repo:${REPO}:merge_group`,
	event_name: 'merge_group',
	ref: 'refs/heads/gh-readonly-queue/main/pr-9-0000',
	base_ref: '',
	workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/gh-readonly-queue/main/pr-9-0000`,
})

describe('find-validated-tree', () => {
	it('answers yes for a successful same-repository ci.yml pull_request run', async () => {
		const { result, fetch } = await ask(routesFor())
		assert.equal(result.validated, true, result.reason)
		assert.equal(result.runId, 42)
		assert.equal(result.runUrl, `https://github.com/${REPO}/actions/runs/42`)
		assert.match(fetch.calls[0].url, /name=validated-tree-a{40}&/)
		assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer t0k')
	})

	it('never sends the GitHub token to the OIDC issuer', async () => {
		const { fetch } = await ask(routesFor())
		const jwks = fetch.calls.find((c) => c.url.startsWith(ISSUER))
		assert.ok(jwks, 'the key set should be fetched')
		assert.equal(jwks.init.headers.authorization, undefined)
	})

	it('answers yes for a merge_group run too', async () => {
		const { result } = await ask(routesFor({ runBody: run({ event: 'merge_group' }), ran: { archive: record(jwt(mergeGroupClaims)) } }))
		assert.equal(result.validated, true, result.reason)
	})

	it('accepts a deflated or a stored token entry alike', async () => {
		const stored = zip([['validated-tree.jwt', jwt(), 0]])
		const { result } = await ask(routesFor({ ran: { archive: stored } }))
		assert.equal(result.validated, true, result.reason)
	})

	describe('the executed workflow', () => {
		it('rejects a run whose PR merged into a branch other than main', async () => {
			// The base-branch forgery: an unchanged head merged into `evil-base`,
			// whose only change is a ci.yml that uploads validated-tree-<T>. The
			// head carries the reviewed blob; the token says where it merged.
			const { result } = await ask(routesFor({ ran: { archive: record(jwt(claims({ base_ref: 'evil-base' }))) } }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /merged into "evil-base", not main/)
		})

		it('rejects a run whose merge commit carries a forged ci.yml, even into main', async () => {
			const { result } = await ask(routesFor({ ran: { blob: FORGED_BLOB } }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /other than the pushed commit's/)
			assert.match(result.reason, new RegExp(FORGED_BLOB))
		})

		it('reads the workflow file at the token\'s workflow_sha, not the PR head', async () => {
			const { fetch } = await ask(routesFor())
			assert.ok(fetch.calls.some((c) => c.url.endsWith(`ci.yml?ref=${MERGE_SHA}`)))
			assert.ok(!fetch.calls.some((c) => c.url.endsWith(`ci.yml?ref=${HEAD_SHA}`)))
		})

		it('does not need pull_requests on the run, which is empty once the PR merged', async () => {
			const { result } = await ask(routesFor({ runBody: run({ pull_requests: [] }) }))
			assert.equal(result.validated, true, result.reason)
		})

		it('rejects a run whose checked-out commit carries another tree', async () => {
			const { result } = await ask(routesFor({ ran: { tree: OTHER_TREE } }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /checked out/)
		})

		it('rejects a merge_group run whose queue commit carries another tree', async () => {
			const { result } = await ask(routesFor({ runBody: run({ event: 'merge_group' }), ran: { archive: record(jwt(mergeGroupClaims)), tree: OTHER_TREE } }))
			assert.equal(result.validated, false)
		})

		it('rejects a merge_group run whose queue commit carries a forged ci.yml', async () => {
			const { result } = await ask(routesFor({ runBody: run({ event: 'merge_group' }), ran: { archive: record(jwt(mergeGroupClaims)), blob: FORGED_BLOB } }))
			assert.equal(result.validated, false)
		})

		it('rejects a ci.yml path that is not a file at the workflow commit', async () => {
			const { result } = await ask(routesFor({ ran: { blob: [ciFile()] } }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /could not be read as a file/)
		})

		it('answers no when the executed ci.yml cannot be fetched', async () => {
			const { result } = await ask(routesFor({ ran: { blob: 404 } }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /404/)
		})
	})

	describe('the OIDC token', () => {
		const refuses = async (token, pattern) => {
			const { result } = await ask(routesFor({ ran: { archive: record(token) } }))
			assert.equal(result.validated, false)
			if (pattern) assert.match(result.reason, pattern)
		}

		it('rejects a record with no token, as the pre-token records have', async () => {
			const { result } = await ask(routesFor({ ran: { archive: zip([['validated-tree.json', '{}']]) } }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /holds no validated-tree\.jwt/)
		})

		it('rejects a token signed by a key the issuer does not publish', () => refuses(jwt(claims(), { key: strangerKey }), /signature does not verify/))
		it('rejects a token naming an unknown key id', () =>
			refuses(jwt(claims(), { header: { alg: 'RS256', kid: 'k9' } }), /no RSA key "k9"/))
		it('rejects an unsigned token', () => refuses(jwt(claims(), { header: { alg: 'none', kid: 'k1' } }), /not RS256/))
		it('rejects a tampered claim', async () => {
			const [h, , sig] = jwt().split('.')
			const body = Buffer.from(JSON.stringify(claims({ base_ref: 'main', run_id: '43' }))).toString('base64url')
			await refuses(`${h}.${body}.${sig}`, /signature does not verify/)
		})
		it('rejects another run\'s token copied into this artifact', () => refuses(jwt(claims({ run_id: '41' })), /minted for run "41"/))
		it('rejects another issuer', () => refuses(jwt(claims({ iss: 'https://evil.test' })), /issued by/))
		it('rejects another audience', () => refuses(jwt(claims({ aud: 'sts.amazonaws.com' })), /not namzu-validated-tree/))
		it('rejects another repository', () => refuses(jwt(claims({ repository: 'mallory/namzu' })), /names repository/))
		it('rejects another event', () => refuses(jwt(claims({ event_name: 'push' })), /names event/))
		it('rejects another workflow', () =>
			refuses(jwt(claims({ workflow_ref: `${REPO}/.github/workflows/evil.yml@refs/pull/9/merge` })), /names workflow/))
		it('rejects a pull_request token whose ref is not a merge ref', () => refuses(jwt(claims({ ref: 'refs/heads/evil-base' })), /names ref/))
		it('rejects a token with no base branch on a pull_request run', () => refuses(jwt(claims({ base_ref: undefined })), /merged into undefined/))
		it('rejects a token with no checked-out commit', () => refuses(jwt(claims({ sha: 'HEAD' })), /no checked-out commit/))
		it('rejects garbage', () => refuses('not.a.jwt!', /verifiable/))

		it('rejects an archive whose digest is not the artifact\'s', async () => {
			const { result } = await ask(routesFor({ artifacts: [artifact({ digest: `sha256:${'0'.repeat(64)}` })] }))
			assert.equal(result.validated, false)
			assert.match(result.reason, /digest/)
		})

		it('rejects an artifact too large to be a record, without downloading it', async () => {
			const { result, fetch } = await ask(routesFor({ artifacts: [artifact({ size_in_bytes: 10_000_000 })] }))
			assert.equal(result.validated, false)
			assert.ok(!fetch.calls.some((c) => c.url.endsWith('/zip')))
		})

		it('answers no when the key set cannot be fetched', async () => {
			const { result } = await ask([[`${ISSUER}/.well-known/jwks`, 503], ...routesFor()])
			assert.equal(result.validated, false)
			assert.match(result.reason, /503/)
		})
	})

	describe('readZipEntry', () => {
		it('refuses a name held twice', () => {
			assert.throws(() => readZipEntry(zip([['a', 'x'], ['a', 'y']]), 'a'), /twice/)
		})
		it('refuses an entry that inflates past the cap', () => {
			assert.throws(() => readZipEntry(zip([['a', 'x'.repeat(100_000)]]), 'a', 1024), /larger than/)
		})
		it('refuses a truncated archive', () => {
			const whole = zip([['a', 'x']])
			assert.throws(() => readZipEntry(whole.subarray(0, whole.length - 30), 'a'))
		})
	})

	it('rejects a run with no head commit', async () => {
		const { result } = await ask(routesFor({ runBody: run({ head_sha: undefined }) }))
		assert.equal(result.validated, false)
		assert.match(result.reason, /no head commit/)
	})

	it('rejects an artifact whose recorded head commit is not the run\'s', async () => {
		const moved = artifact({ workflow_run: { id: 42, repository_id: 7, head_repository_id: 7, head_sha: 'f'.repeat(40) } })
		const { result } = await ask(routesFor({ artifacts: [moved] }))
		assert.equal(result.validated, false)
	})

	it('answers no without the pushed ci.yml blob, without asking', async () => {
		const { result, fetch } = await ask(routesFor(), { ciBlob: undefined })
		assert.equal(result.validated, false)
		assert.equal(fetch.calls.length, 0)
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
		const { result } = await ask([[LIST, 500]])
		assert.equal(result.validated, false)
		assert.match(result.reason, /500/)
	})

	it('answers no on an API error from the run lookup', async () => {
		const { result } = await ask([[LIST, listing([artifact()])], [`${API}/repos/${REPO}/actions/runs/42`, 403]])
		assert.equal(result.validated, false)
	})

	it('answers no when fetch itself throws', async () => {
		const { result } = await ask([[`${API}/`, new Error('ECONNRESET')]])
		assert.equal(result.validated, false)
		assert.match(result.reason, /ECONNRESET/)
	})

	it('answers no on a listing of the wrong shape', async () => {
		const { result } = await ask([[LIST, { artifacts: 'nope' }]])
		assert.equal(result.validated, false)
	})

	it('answers no when only another tree was validated', async () => {
		// The listing is filtered by name server-side; a response carrying another
		// tree's record must still not count.
		const other = artifact({ name: `validated-tree-${OTHER_TREE}` })
		const { result } = await ask([[LIST, listing([other])], [`${API}/repos/${REPO}/actions/runs/42`, run()]])
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
			[LIST, listing([failed, artifact()])],
			[`${API}/repos/${REPO}/actions/runs/41`, run({ id: 41, conclusion: 'cancelled' })],
			[`${API}/repos/${REPO}/actions/runs/42`, run()],
			...executed(),
		])
		assert.equal(result.validated, true, result.reason)
		assert.equal(result.runId, 42)
	})

	it('keeps looking past an artifact whose token names another base', async () => {
		const forged = artifact({ id: 10, workflow_run: { id: 41, repository_id: 7, head_repository_id: 7, head_sha: HEAD_SHA } })
		const { result } = await ask([
			[LIST, listing([forged, artifact()])],
			[`${API}/repos/${REPO}/actions/runs/41`, run({ id: 41 })],
			[`${API}/repos/${REPO}/actions/artifacts/10/zip`, record(jwt(claims({ run_id: '41', base_ref: 'evil-base' })))],
			[`${API}/repos/${REPO}/actions/runs/42`, run()],
			...executed(),
		])
		assert.equal(result.validated, true, result.reason)
		assert.equal(result.runId, 42)
	})

	it('answers no when more pages exist than it will read and none qualified', async () => {
		const expired = Array.from({ length: 100 }, (_, i) => artifact({ id: i, expired: true }))
		const { result, fetch } = await ask([[LIST, listing(expired, 10_000)]])
		assert.equal(result.validated, false)
		assert.equal(fetch.calls.length, 5)
	})
})

describe('find-validated-tree as release.yml runs it', () => {
	it('writes skip=false to GITHUB_OUTPUT and exits 0 when the lookup cannot be made', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-validated-tree-'))
		try {
			const output = join(dir, 'out')
			const result = spawnSync(process.execPath, ['.github/scripts/find-validated-tree.mjs', '--repo', REPO, '--tree', TREE, '--ci-blob', CI_BLOB], {
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
