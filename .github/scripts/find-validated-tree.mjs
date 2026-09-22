#!/usr/bin/env node
/**
 * Has `ci.yml` already validated this exact tree?
 *
 * ## Why release.yml asks
 *
 * Every push to `main` runs `release.yml`, which runs the validation gates
 * inline before the Changesets action. For a pull-request merge that is usually
 * a second measurement of something already measured: the PR's `ci.yml` run
 * built `refs/pull/N/merge`, and when `main` did not move before the merge, the
 * tree that lands is byte-for-byte the tree that run validated. Re-running the
 * gates on it learns nothing and holds the publish back by twenty minutes or
 * more.
 *
 * So `ci.yml`'s last job, once every gate job has succeeded, uploads an
 * artifact named `validated-tree-<tree sha>`. This script looks for one. A git
 * tree sha names content, not history, so a match means "these exact bytes
 * passed every gate", whichever commit carried them.
 *
 * ## What counts as a match
 *
 * An artifact named exactly `validated-tree-<tree>`, not expired, whose
 * producing workflow run:
 *
 *   - is `.github/workflows/ci.yml`,
 *   - completed with conclusion `success`,
 *   - was triggered by `pull_request` or `merge_group`, and
 *   - ran from this repository, never a fork, and
 *   - carries, inside the artifact, a workflow OIDC token for audience
 *     `namzu-validated-tree`, signed by GitHub's issuer, whose claims name
 *     this repository, this run, this event, `ci.yml` as the workflow and, for
 *     `pull_request`, `main` as the base; and the commit the token names as
 *     the workflow's source (`workflow_sha`) carries the pushed commit's
 *     `.github/workflows/ci.yml` blob (`--ci-blob`), and the commit it names
 *     as checked out (`sha`) carries the tree asked about.
 *
 * ## Why the provenance of the run is not enough
 *
 * The artifact's NAME is whatever the workflow that ran chose to write, and a
 * `pull_request` run executes the PR's own copy of `ci.yml`. The fork rule
 * stops a fork's rewritten copy: its run's head repository is the fork. It
 * does not stop a write collaborator who pushes a branch whose `ci.yml` is one
 * job uploading `validated-tree-<T>` for a tree `T` some other PR will land
 * (a tree sha is computable offline), opens a PR and closes it. That run is
 * `ci.yml`, `pull_request`, this repository and `success`. Nothing on `main`'s
 * ruleset stops the later merge either: it requires a review, not a green
 * status check, so this lookup is the only thing between that record and a
 * publish with no gate run.
 *
 * So the run must be shown to have executed the reviewed workflow, and the
 * workflow run object cannot show it. A `pull_request` run executes the file
 * in `refs/pull/N/merge`, a merge of the PR head with its BASE branch, and the
 * base need not be `main`: a PR from an unchanged branch into a branch whose
 * only change is a forged `ci.yml` runs the forged file (the reviewed file's
 * `branches: [main]` filter is not the one that is read), while its head
 * commit still carries the reviewed blob. The run object's `head_sha` is that
 * head, not the merge. Its `pull_requests` list would name the base, but it
 * lists only pull requests open NOW, and by the time release.yml asks, the PR
 * that landed the tree has merged: every `pull_request` run of this
 * repository's ci.yml read on 2026-09-22 (100 of 100) had an empty list. The
 * pull-request API is no better: a PR's base can be retargeted after the run.
 *
 * The OIDC token is the one account of the run GitHub signs and the workflow
 * cannot write: `sha` is the commit checked out (for `pull_request`, the merge
 * commit itself), `workflow_sha` the commit the executing workflow file came
 * from, `base_ref` the base branch at the time. A forged run can ask for a
 * token too, and it says `base_ref: evil-base` and names a merge commit whose
 * `ci.yml` is the forged one. It cannot reuse another run's token either:
 * `run_id` must be the run that owns the artifact, which GitHub sets. With the
 * executed file proven to be the reviewed one, the artifact's name is the one
 * that file writes: `git rev-parse HEAD^{tree}` of the checkout its gates ran
 * on, checked here against `sha` anyway. The token is expired by the time a
 * merge lands; its signature and claims still attest what they attested, and
 * a token signed by a key GitHub has since rotated out answers no.
 *
 * ## Every doubt answers no
 *
 * An API error, a malformed response, a missing field, a tree sha that is not
 * one: all of them answer "not validated", and release.yml runs every gate.
 * Being wrong in that direction costs twenty minutes; being wrong in the other
 * publishes a tree nothing checked. The script never exits non-zero for a
 * lookup failure, because a failed step would stop the release instead of
 * falling back to the full validation it can always do.
 *
 * Usage (as release.yml runs it):
 *
 *   GITHUB_TOKEN=… node .github/scripts/find-validated-tree.mjs \
 *     --repo owner/name --tree "$(git rev-parse 'HEAD^{tree}')" \
 *     --ci-blob "$(git rev-parse 'HEAD:.github/workflows/ci.yml')"
 *
 * It prints the decision and its reason, and when `GITHUB_OUTPUT` is set
 * writes `skip=true|false`, `reason=…` and `run_url=…` there.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'

export const ARTIFACT_PREFIX = 'validated-tree-'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
/** The file inside the artifact that holds the run's OIDC token. */
export const TOKEN_FILE = 'validated-tree.jwt'
/** The audience ci.yml asks for; nothing else accepts a token minted for it. */
export const OIDC_AUDIENCE = 'namzu-validated-tree'
export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const ALLOWED_EVENTS = new Set(['pull_request', 'merge_group'])
/** The artifact is a JSON line and a JWT; anything much bigger is not ours. */
const MAX_ARTIFACT_BYTES = 64 * 1024
const PER_PAGE = 100
/** Beyond this many pages of same-named artifacts, stop looking and answer no. */
const MAX_PAGES = 5

const TREE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const OBJECT_SHA = TREE_SHA
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function no(reason) {
	return { validated: false, reason }
}

/**
 * `path` on a workflow run is `.github/workflows/ci.yml`, and the REST
 * documentation also shows it with an `@<ref>` suffix. Either form names the
 * file; anything else does not.
 */
function isCiWorkflowPath(path) {
	return path === CI_WORKFLOW_PATH || (typeof path === 'string' && path.startsWith(`${CI_WORKFLOW_PATH}@`))
}

async function request(fetchImpl, url, token) {
	const headers = { accept: 'application/vnd.github+json', 'user-agent': 'namzu-release-find-validated-tree' }
	if (token !== undefined) {
		headers.authorization = `Bearer ${token}`
		headers['x-github-api-version'] = '2022-11-28'
	}
	const response = await fetchImpl(url, { headers })
	if (!response || !response.ok) {
		throw new Error(`GET ${url} answered ${response ? response.status : 'nothing'}`)
	}
	return response
}

async function getJson(fetchImpl, url, token) {
	return (await request(fetchImpl, url, token)).json()
}

/**
 * The bytes of the one entry named `wanted` in a zip archive, or an Error
 * saying why not. Stored and deflated entries only; an encrypted entry, a
 * second entry of the same name, an entry larger than `maxBytes`, or any
 * offset outside the buffer is an error.
 */
export function readZipEntry(buffer, wanted, maxBytes = MAX_ARTIFACT_BYTES) {
	const buf = Buffer.from(buffer)
	const need = (offset, length) => {
		if (!Number.isInteger(offset) || offset < 0 || offset + length > buf.length) throw new Error('the zip is truncated')
	}
	let eocd = -1
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new Error('not a zip archive')
	const count = buf.readUInt16LE(eocd + 10)
	let offset = buf.readUInt32LE(eocd + 16)
	let found = null
	for (let n = 0; n < count; n += 1) {
		need(offset, 46)
		if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('the zip central directory is malformed')
		const flags = buf.readUInt16LE(offset + 8)
		const method = buf.readUInt16LE(offset + 10)
		const compressed = buf.readUInt32LE(offset + 20)
		const size = buf.readUInt32LE(offset + 24)
		const nameLength = buf.readUInt16LE(offset + 28)
		const extraLength = buf.readUInt16LE(offset + 30)
		const commentLength = buf.readUInt16LE(offset + 32)
		const local = buf.readUInt32LE(offset + 42)
		need(offset + 46, nameLength)
		const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
		if (name === wanted) {
			if (found) throw new Error(`the zip holds ${wanted} twice`)
			found = { flags, method, compressed, size, local }
		}
		offset += 46 + nameLength + extraLength + commentLength
	}
	if (!found) throw new Error(`the zip holds no ${wanted}`)
	if (found.flags & 1) throw new Error(`${wanted} is encrypted`)
	if (found.size > maxBytes || found.compressed > maxBytes) throw new Error(`${wanted} is larger than ${maxBytes} bytes`)
	need(found.local, 30)
	if (buf.readUInt32LE(found.local) !== 0x04034b50) throw new Error('the zip local header is malformed')
	const start = found.local + 30 + buf.readUInt16LE(found.local + 26) + buf.readUInt16LE(found.local + 28)
	need(start, found.compressed)
	const data = buf.subarray(start, start + found.compressed)
	let bytes
	if (found.method === 0) bytes = data
	else if (found.method === 8) bytes = inflateRawSync(data, { maxOutputLength: maxBytes })
	else throw new Error(`${wanted} uses compression method ${found.method}`)
	if (bytes.length !== found.size) throw new Error(`${wanted} is ${bytes.length} bytes, the zip says ${found.size}`)
	return bytes
}

function base64url(text) {
	if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('the token is not base64url')
	return Buffer.from(text, 'base64url')
}

/**
 * The claims of a compact RS256 JWT whose signature verifies against the
 * issuer's published keys, or an Error. Expiry is deliberately not checked:
 * the token is read as a signed record of a run that has finished, not as a
 * credential.
 */
async function verifiedClaims(fetchImpl, jwt, issuer, jwksCache) {
	const parts = jwt.split('.')
	if (parts.length !== 3) throw new Error('the token is not a compact JWT')
	const header = JSON.parse(base64url(parts[0]).toString('utf8'))
	if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error(`the token is signed ${JSON.stringify(header?.alg)}, not RS256 with a key id`)
	if (!jwksCache.keys) {
		const jwks = await getJson(fetchImpl, `${issuer}/.well-known/jwks`)
		if (!jwks || !Array.isArray(jwks.keys)) throw new Error("the issuer's key set was not the expected shape")
		jwksCache.keys = jwks.keys
	}
	const jwk = jwksCache.keys.find((key) => key && key.kid === header.kid && key.kty === 'RSA')
	if (!jwk) throw new Error(`the issuer publishes no RSA key ${JSON.stringify(header.kid)}`)
	const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' })
	if (!verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, base64url(parts[2]))) {
		throw new Error('the token signature does not verify')
	}
	const claims = JSON.parse(base64url(parts[1]).toString('utf8'))
	if (!claims || typeof claims !== 'object') throw new Error('the token carries no claims')
	return claims
}

/**
 * Why a workflow run cannot vouch for the tree, or `null` when it can.
 */
function runRejection(run, repo) {
	if (!run || typeof run !== 'object') return 'the run could not be read'
	if (!isCiWorkflowPath(run.path)) return `run ${run.id} is ${JSON.stringify(run.path)}, not ${CI_WORKFLOW_PATH}`
	if (run.status !== 'completed' || run.conclusion !== 'success') {
		return `run ${run.id} is ${run.status}/${run.conclusion}, not completed/success`
	}
	if (!ALLOWED_EVENTS.has(run.event)) return `run ${run.id} was triggered by ${JSON.stringify(run.event)}, not pull_request or merge_group`
	const head = run.head_repository?.full_name
	if (typeof head !== 'string' || head.toLowerCase() !== repo.toLowerCase()) {
		return `run ${run.id} ran from ${JSON.stringify(head)}, not ${repo}`
	}
	const owner = run.repository?.full_name
	if (owner !== undefined && (typeof owner !== 'string' || owner.toLowerCase() !== repo.toLowerCase())) {
		return `run ${run.id} belongs to ${JSON.stringify(owner)}, not ${repo}`
	}
	return null
}

function artifactRejection(artifact, name, now) {
	if (!artifact || typeof artifact !== 'object') return 'an artifact could not be read'
	if (artifact.name !== name) return `artifact ${artifact.id} is named ${JSON.stringify(artifact.name)}`
	if (artifact.expired !== false) return `artifact ${artifact.id} has expired`
	if (artifact.expires_at !== undefined && artifact.expires_at !== null) {
		const expires = Date.parse(artifact.expires_at)
		if (!Number.isFinite(expires) || expires <= now) return `artifact ${artifact.id} has expired`
	}
	const runId = artifact.workflow_run?.id
	if (!Number.isInteger(runId)) return `artifact ${artifact.id} names no workflow run`
	const { repository_id: repoId, head_repository_id: headId } = artifact.workflow_run
	if (repoId !== undefined && headId !== undefined && repoId !== headId) {
		return `artifact ${artifact.id} came from a run whose head repository is another repository`
	}
	return null
}

/**
 * Why the claims do not say this run executed `ci.yml` in this repository for
 * this event (and, for a pull request, into `baseBranch`), or `null`.
 */
function claimsRejection(claims, { run, repo, issuer, baseBranch }) {
	const lower = repo.toLowerCase()
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
	if (claims.iss !== issuer) return `its token was issued by ${JSON.stringify(claims.iss)}, not ${issuer}`
	if (!audience.includes(OIDC_AUDIENCE)) return `its token is for ${JSON.stringify(claims.aud)}, not ${OIDC_AUDIENCE}`
	if (typeof claims.repository !== 'string' || claims.repository.toLowerCase() !== lower) {
		return `its token names repository ${JSON.stringify(claims.repository)}`
	}
	if (claims.run_id !== String(run.id)) return `its token was minted for run ${JSON.stringify(claims.run_id)}`
	if (claims.event_name !== run.event) return `its token names event ${JSON.stringify(claims.event_name)}, the run says ${run.event}`
	const workflow = `${lower}/${CI_WORKFLOW_PATH}@`
	if (typeof claims.workflow_ref !== 'string' || !claims.workflow_ref.toLowerCase().startsWith(workflow)) {
		return `its token names workflow ${JSON.stringify(claims.workflow_ref)}`
	}
	if (run.event === 'pull_request') {
		if (claims.base_ref !== baseBranch) return `its token says the pull request merged into ${JSON.stringify(claims.base_ref)}, not ${baseBranch}`
		if (typeof claims.ref !== 'string' || !/^refs\/pull\/\d+\/merge$/.test(claims.ref)) return `its token names ref ${JSON.stringify(claims.ref)}`
	}
	if (typeof claims.sha !== 'string' || !OBJECT_SHA.test(claims.sha)) return `its token names no checked-out commit`
	if (typeof claims.workflow_sha !== 'string' || !OBJECT_SHA.test(claims.workflow_sha)) return `its token names no workflow commit`
	return null
}

/**
 * Why the run cannot be shown to have executed the reviewed `ci.yml` on the
 * tree asked about, or `null` when it can. Reads the OIDC token from the
 * artifact, verifies it, then asks the API for the `ci.yml` blob at the
 * token's `workflow_sha` and the tree of its `sha`.
 */
async function executionRejection(context) {
	const { fetchImpl, base, repo, token, run, artifact, tree, ciBlob, issuer, baseBranch, jwksCache } = context
	const headSha = run.head_sha
	if (typeof headSha !== 'string' || !OBJECT_SHA.test(headSha)) {
		return `run ${run.id} names no head commit (${JSON.stringify(headSha)})`
	}
	const recorded = artifact.workflow_run?.head_sha
	if (recorded !== undefined && recorded !== headSha) {
		return `artifact ${artifact.id} says run ${run.id} ran ${JSON.stringify(recorded)}, the run says ${headSha}`
	}
	if (typeof artifact.size_in_bytes === 'number' && artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
		return `artifact ${artifact.id} is ${artifact.size_in_bytes} bytes, more than a validated-tree record`
	}

	let claims
	try {
		const response = await request(fetchImpl, `${base}/repos/${repo}/actions/artifacts/${artifact.id}/zip`, token)
		const zip = Buffer.from(await response.arrayBuffer())
		if (zip.length > MAX_ARTIFACT_BYTES) throw new Error(`the archive is ${zip.length} bytes`)
		if (typeof artifact.digest === 'string' && artifact.digest.startsWith('sha256:')) {
			const digest = `sha256:${createHash('sha256').update(zip).digest('hex')}`
			if (digest !== artifact.digest) throw new Error(`the archive digest is ${digest}, the artifact says ${artifact.digest}`)
		}
		const jwt = readZipEntry(zip, TOKEN_FILE).toString('utf8').trim()
		claims = await verifiedClaims(fetchImpl, jwt, issuer, jwksCache)
	} catch (error) {
		return `run ${run.id}: artifact ${artifact.id} holds no verifiable OIDC token (${error instanceof Error ? error.message : String(error)})`
	}
	const refused = claimsRejection(claims, { run, repo, issuer, baseBranch })
	if (refused) return `run ${run.id}: ${refused}`

	const file = await getJson(fetchImpl, `${base}/repos/${repo}/contents/${CI_WORKFLOW_PATH}?ref=${claims.workflow_sha}`, token)
	if (!file || file.type !== 'file' || typeof file.sha !== 'string') {
		return `run ${run.id}: ${CI_WORKFLOW_PATH} at ${claims.workflow_sha} could not be read as a file`
	}
	if (file.sha !== ciBlob) {
		return `run ${run.id} ran a ${CI_WORKFLOW_PATH} (blob ${file.sha} at ${claims.workflow_sha}) other than the pushed commit's (blob ${ciBlob})`
	}
	const commit = await getJson(fetchImpl, `${base}/repos/${repo}/git/commits/${claims.sha}`, token)
	const ranTree = commit?.tree?.sha
	if (ranTree !== tree) return `${run.event} run ${run.id} checked out ${claims.sha}, tree ${JSON.stringify(ranTree)}, not ${tree}`
	return null
}

/**
 * @param {object} options
 * @param {string} options.repo `owner/name`
 * @param {string} options.tree the tree sha to look for
 * @param {string} options.ciBlob the blob sha of `.github/workflows/ci.yml` in that tree
 * @param {string} options.token a token with `actions: read`
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiUrl]
 * @param {number} [options.now] epoch milliseconds
 * @param {string} [options.oidcIssuer] the issuer whose signed token the artifact must carry
 * @param {string} [options.baseBranch] the only base a pull_request run may have merged into
 * @returns {Promise<{validated: boolean, reason: string, runUrl?: string, runId?: number}>}
 */
export async function findValidatedTree({
	repo,
	tree,
	ciBlob,
	token,
	fetch: fetchImpl = globalThis.fetch,
	apiUrl = 'https://api.github.com',
	now = Date.now(),
	oidcIssuer = OIDC_ISSUER,
	baseBranch = 'main',
}) {
	if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return no(`${JSON.stringify(repo)} is not owner/name`)
	if (typeof tree !== 'string' || !TREE_SHA.test(tree)) return no(`${JSON.stringify(tree)} is not a tree sha`)
	if (typeof ciBlob !== 'string' || !OBJECT_SHA.test(ciBlob)) {
		return no(`${JSON.stringify(ciBlob)} is not the blob sha of ${CI_WORKFLOW_PATH}`)
	}
	if (typeof token !== 'string' || token === '') return no('no token to ask the API with')
	if (typeof fetchImpl !== 'function') return no('no fetch available')

	const name = `${ARTIFACT_PREFIX}${tree}`
	const base = apiUrl.replace(/\/+$/, '')
	const rejections = []
	const issuer = oidcIssuer.replace(/\/+$/, '')
	const jwksCache = {}

	try {
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const url = `${base}/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=${PER_PAGE}&page=${page}`
			const body = await getJson(fetchImpl, url, token)
			if (!body || !Array.isArray(body.artifacts) || !Number.isInteger(body.total_count)) {
				return no(`the artifact listing for ${name} was not the expected shape`)
			}

			for (const artifact of body.artifacts) {
				const rejected = artifactRejection(artifact, name, now)
				if (rejected) {
					rejections.push(rejected)
					continue
				}
				const run = await getJson(fetchImpl, `${base}/repos/${repo}/actions/runs/${artifact.workflow_run.id}`, token)
				const refused = runRejection(run, repo)
				if (refused) {
					rejections.push(refused)
					continue
				}
				if (run.id !== artifact.workflow_run.id) {
					rejections.push(`run ${artifact.workflow_run.id} answered as run ${run.id}`)
					continue
				}
				const unexecuted = await executionRejection({
					fetchImpl,
					base,
					repo,
					token,
					run,
					artifact,
					tree,
					ciBlob,
					issuer,
					baseBranch,
					jwksCache,
				})
				if (unexecuted) {
					rejections.push(unexecuted)
					continue
				}
				return {
					validated: true,
					reason: `artifact ${name} from ${run.event} run ${run.id} of ${CI_WORKFLOW_PATH} (success, ${repo}, OIDC-attested: ran blob ${ciBlob}, checked out tree ${tree})`,
					runId: run.id,
					runUrl: typeof run.html_url === 'string' ? run.html_url : `https://github.com/${repo}/actions/runs/${run.id}`,
				}
			}

			if (body.artifacts.length === 0 || page * PER_PAGE >= body.total_count) break
			if (page === MAX_PAGES) {
				return no(`${body.total_count} artifacts named ${name}, more than ${MAX_PAGES} pages; none of those read qualified`)
			}
		}
	} catch (error) {
		return no(`the API could not be read: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (rejections.length === 0) return no(`no artifact named ${name}`)
	return no(`no qualifying artifact named ${name}: ${rejections.join('; ')}`)
}

function parseArgs(argv) {
	const args = {}
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i]
		if (flag === '--repo' || flag === '--tree' || flag === '--ci-blob') {
			args[flag.slice(2)] = argv[i + 1]
			i += 1
		}
	}
	return args
}

/** A value written to GITHUB_OUTPUT on one line, so it cannot inject a second key. */
function oneLine(value) {
	return String(value).replace(/[\r\n]+/g, ' ')
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	let result
	try {
		result = await findValidatedTree({
			repo: args.repo ?? process.env.GITHUB_REPOSITORY,
			tree: args.tree,
			ciBlob: args['ci-blob'],
			token: process.env.GITHUB_TOKEN,
			apiUrl: process.env.GITHUB_API_URL || undefined,
		})
	} catch (error) {
		result = no(`the lookup failed: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (result.validated) {
		console.log(`✓ tree ${args.tree} was already validated by CI — the validation gates are skipped.`)
		console.log(`  ${result.reason}`)
		console.log(`  ${result.runUrl}`)
	} else {
		console.log(`✗ tree ${args.tree} has no qualifying CI validation — every validation gate runs.`)
		console.log(`  ${result.reason}`)
	}

	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`skip=${result.validated ? 'true' : 'false'}\nreason=${oneLine(result.reason)}\nrun_url=${oneLine(result.runUrl ?? '')}\n`,
		)
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main()
}
