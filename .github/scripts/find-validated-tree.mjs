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
 *   - ran from this repository, never a fork.
 *
 * The fork rule is the one that matters. A `pull_request` run takes its
 * workflow file from the merge ref, so a fork can rewrite `ci.yml` to upload
 * the record without running a gate. Its run's head repository is the fork, and
 * that is what rejects it.
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
 *     --repo owner/name --tree "$(git rev-parse 'HEAD^{tree}')"
 *
 * It prints the decision and its reason, and when `GITHUB_OUTPUT` is set
 * writes `skip=true|false`, `reason=…` and `run_url=…` there.
 */

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ARTIFACT_PREFIX = 'validated-tree-'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
const ALLOWED_EVENTS = new Set(['pull_request', 'merge_group'])
const PER_PAGE = 100
/** Beyond this many pages of same-named artifacts, stop looking and answer no. */
const MAX_PAGES = 5

const TREE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
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

async function getJson(fetchImpl, url, token) {
	const response = await fetchImpl(url, {
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'x-github-api-version': '2022-11-28',
			'user-agent': 'namzu-release-find-validated-tree',
		},
	})
	if (!response || !response.ok) {
		throw new Error(`GET ${url} answered ${response ? response.status : 'nothing'}`)
	}
	return response.json()
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
 * @param {object} options
 * @param {string} options.repo `owner/name`
 * @param {string} options.tree the tree sha to look for
 * @param {string} options.token a token with `actions: read`
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiUrl]
 * @param {number} [options.now] epoch milliseconds
 * @returns {Promise<{validated: boolean, reason: string, runUrl?: string, runId?: number}>}
 */
export async function findValidatedTree({
	repo,
	tree,
	token,
	fetch: fetchImpl = globalThis.fetch,
	apiUrl = 'https://api.github.com',
	now = Date.now(),
}) {
	if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return no(`${JSON.stringify(repo)} is not owner/name`)
	if (typeof tree !== 'string' || !TREE_SHA.test(tree)) return no(`${JSON.stringify(tree)} is not a tree sha`)
	if (typeof token !== 'string' || token === '') return no('no token to ask the API with')
	if (typeof fetchImpl !== 'function') return no('no fetch available')

	const name = `${ARTIFACT_PREFIX}${tree}`
	const base = apiUrl.replace(/\/+$/, '')
	const rejections = []

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
				return {
					validated: true,
					reason: `artifact ${name} from ${run.event} run ${run.id} of ${CI_WORKFLOW_PATH} (success, ${repo})`,
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
		if (flag === '--repo' || flag === '--tree') {
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
