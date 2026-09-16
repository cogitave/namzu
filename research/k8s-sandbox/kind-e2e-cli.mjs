#!/usr/bin/env node
/**
 * W10 reproducible driver: builds the two images this end-to-end run needs,
 * loads them into a local kind cluster running the real agent-sandbox
 * v1.0.2 controller, applies the kind overlay into namespace `namzu-e2e`,
 * runs the runner Job and the W8 acceptance-script Job, collects results,
 * and cleans the namespace back up.
 *
 * ## Where this runs
 *
 * This is a research artifact, not product code, and it is tied to the
 * ONE environment it was authored against: an Arch Linux WSL2 distro that
 * cannot see a SEPARATE WSL2 distro (`podman-machine-default`) running
 * Podman, kind (`KIND_EXPERIMENTAL_PROVIDER=podman`) and a cluster named
 * `namzu` with `kubectl get runtimeclass` empty and agent-sandbox v1.0.2
 * already installed — see `docs/sdk/kubernetes-sandbox.md` and this
 * directory's `kind-e2e-results.md` for how that cluster was built
 * (`kind create cluster` + the standard-install manifest). `kubectl`
 * against that cluster (`~/.kube/config`, context `kind-namzu`) is assumed
 * to already work from THIS shell — both WSL2 distros share the Windows
 * host's loopback, which is also how this script moves large build
 * contexts across the distro boundary (see `wslCurlFetch` below) without
 * ever piping bytes through `wsl.exe`'s own stdin, which this session
 * found silently corrupts anything past a few KB (a login-shell fallback
 * swallows piped stdin as interactive commands — see the "Known quirks"
 * section of `kind-e2e-results.md`).
 *
 * ## Usage
 *
 *   node research/k8s-sandbox/kind-e2e-cli.mjs <command>
 *
 * Commands (run `all` for the full pipeline used to produce
 * `kind-e2e-results.json`):
 *   build-agent-image   Build packages/sandbox/k8s/Dockerfile in the podman
 *                        machine, tag namzu-sandbox-agent:kind, load into kind.
 *   build-runner-image  Pack @namzu/sdk + @namzu/sandbox, assemble the runner
 *                        image (this directory's runner.mjs/lease-holder.mjs/
 *                        k8s-scripts), load into kind as namzu-e2e-runner:kind.
 *   apply               Render the kind overlay into namespace namzu-e2e and
 *                        apply it; wait for the warm pool.
 *   run                 Apply + wait for the runner Job; collect its JSON.
 *   run-w8              Apply + wait for the W8 acceptance-script Job.
 *   collect             Write kind-e2e-results.json from the two Jobs' logs
 *                        (assumes both have already completed).
 *   cleanup             Delete namespace namzu-e2e. Cluster/controller/images
 *                        are left running, per this run's own instructions.
 *   all                 build-agent-image, build-runner-image, apply, run,
 *                        run-w8, collect, cleanup, in that order.
 *
 * ## Not re-verified end-to-end as this single script
 *
 * Every command below is the exact, individually-verified shape this
 * session ran by hand (each `wsl(...)` / `kubectl(...)` call matches a
 * command actually executed against the live cluster while producing
 * `kind-e2e-results.json`). This file assembles them into one script for
 * reproducibility rather than leaving the recipe as shell transcript; it
 * was reviewed for correctness against that transcript, not re-run here
 * start to finish as a single process, since doing so would just re-derive
 * numbers already on record. `kind-e2e-results.md` says so plainly.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SANDBOX_PKG = join(REPO_ROOT, 'packages', 'sandbox')
const NAMESPACE = 'namzu-e2e'
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe'
const PODMAN_MACHINE = 'podman-machine-default'
const KIND_CLUSTER = 'namzu'

function log(...args) {
	console.log(new Date().toISOString(), ...args)
}

/**
 * Run one command inside `podman-machine-default`, in the FOREGROUND, with
 * a generous timeout. `sh -lc '<cmd>'`'s stdin is always `/dev/null` —
 * giving it a real pipe (even a small one) reliably landed on a bare
 * interactive login `-bash` instead of running `<cmd>` at all, in this
 * session's testing (see `kind-e2e-results.md`). Do not add stdin piping
 * here without re-verifying that against the live machine first.
 */
function wsl(cmd, { timeoutMs = 120_000 } = {}) {
	log('[wsl]', cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd)
	const result = spawnSync(WSL_EXE, ['-d', PODMAN_MACHINE, '-u', 'root', '--', 'sh', '-lc', cmd], {
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: timeoutMs,
		encoding: 'utf8',
		cwd: '/',
	})
	const out = (result.stdout ?? '').replace(/\r/g, '')
	const err = (result.stderr ?? '').replace(/\r/g, '')
	// Cosmetic on every invocation from this distro — wsl.exe tries (and
	// fails) to translate a path it has no use for, and still runs the
	// command fine. Never treat its presence as a failure signal.
	const meaningfulErr = err.replace(/^wsl: Failed to translate '[^']*'\n?/, '')
	if (result.status !== 0) {
		throw new Error(`wsl command failed (exit ${result.status}): ${cmd}\n${out}\n${meaningfulErr}`)
	}
	if (meaningfulErr.trim()) log('[wsl:stderr]', meaningfulErr.trim())
	return out
}

function kubectl(args, opts = {}) {
	log('[kubectl]', args.join(' '))
	return execFileSync('kubectl', args, { encoding: 'utf8', ...opts })
}

/**
 * Serve `filePath` once on a random localhost port and fetch it into the
 * podman machine with `curl`. Both WSL2 distros share the Windows host's
 * loopback (confirmed: the kind API server on 127.0.0.1:36443 is reachable
 * from either distro directly), so this moves a multi-MB build context
 * across the distro boundary in one `curl`, instead of thousands of
 * argument-sized `wsl()` calls.
 */
async function wslCurlFetch(filePath, remotePath) {
	const server = createServer((req, res) => {
		const body = readFileSync(filePath)
		res.writeHead(200, { 'Content-Length': body.length })
		res.end(body)
	})
	const port = await new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve(server.address().port))
	})
	try {
		const localSha = execFileSync('sha256sum', [filePath], { encoding: 'utf8' }).split(' ')[0]
		wsl(`curl -s -o ${remotePath} http://127.0.0.1:${port}/payload && sha256sum ${remotePath}`, {
			timeoutMs: 60_000,
		})
		const remoteSha = wsl(`sha256sum ${remotePath}`).split(' ')[0]
		if (remoteSha !== localSha) {
			throw new Error(`transfer checksum mismatch for ${filePath}: local ${localSha} remote ${remoteSha}`)
		}
	} finally {
		server.close()
	}
}

// ---------------------------------------------------------------------------
// build-agent-image
// ---------------------------------------------------------------------------
async function buildAgentImage() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-agent-ctx-'))
	const tarPath = join(scratch, 'agent-ctx.tar')
	// Build context is EXACTLY what packages/sandbox/k8s/Dockerfile COPYs —
	// see that file's own header: agent/agent.cjs and k8s/entrypoint.sh,
	// both siblings of k8s/Dockerfile under packages/sandbox.
	execFileSync('tar', ['-cf', tarPath, '-C', SANDBOX_PKG, 'agent/agent.cjs', 'k8s/Dockerfile', 'k8s/entrypoint.sh'])
	await wslCurlFetch(tarPath, '/root/agent-ctx.tar')
	wsl('podman build -f k8s/Dockerfile -t namzu-sandbox-agent:kind - < /root/agent-ctx.tar', {
		timeoutMs: 300_000,
	})
	wsl('rm -f /root/agent-image.tar && podman save localhost/namzu-sandbox-agent:kind -o /root/agent-image.tar', {
		timeoutMs: 120_000,
	})
	wsl(`KIND_EXPERIMENTAL_PROVIDER=podman kind load image-archive /root/agent-image.tar --name ${KIND_CLUSTER}`, {
		timeoutMs: 120_000,
	})
	rmSync(scratch, { recursive: true, force: true })
	log('agent image loaded as localhost/namzu-sandbox-agent:kind')
}

// ---------------------------------------------------------------------------
// build-runner-image
// ---------------------------------------------------------------------------
async function buildRunnerImage() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-runner-'))
	const tarballsDir = join(scratch, 'tarballs')
	mkdirSync(tarballsDir, { recursive: true })

	// pnpm pack ships @namzu/sandbox's WHOLE dist/ tree (its own `files`
	// field), which is what lets the runner reach
	// dist/testing/sandbox-conformance.js by relative path below even
	// though the package's own `exports` map publishes only ".".
	for (const pkg of ['sdk', 'sandbox']) {
		execFileSync('pnpm', ['pack', '--pack-destination', tarballsDir], {
			cwd: join(REPO_ROOT, 'packages', pkg),
			stdio: 'inherit',
		})
	}
	const sdkTarball = execFileSync('sh', ['-c', `ls ${tarballsDir}/namzu-sdk-*.tgz`], { encoding: 'utf8' }).trim()
	const sandboxTarball = execFileSync('sh', ['-c', `ls ${tarballsDir}/namzu-sandbox-*.tgz`], {
		encoding: 'utf8',
	}).trim()

	writeFileSync(
		join(scratch, 'package.json'),
		JSON.stringify(
			{
				name: 'namzu-k8s-e2e-runner',
				private: true,
				version: '1.0.0',
				type: 'module',
				dependencies: {
					'@namzu/sdk': `file:./tarballs/${sdkTarball.split('/').pop()}`,
					'@namzu/sandbox': `file:./tarballs/${sandboxTarball.split('/').pop()}`,
					zod: '^3.23.0',
					'zod-to-json-schema': '^3.23.0',
					'@opentelemetry/api': '^1.9.0',
				},
			},
			null,
			2,
		),
	)
	execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: scratch, stdio: 'inherit' })

	for (const file of ['runner.mjs', 'lease-holder.mjs', 'Dockerfile']) {
		writeFileSync(join(scratch, file), readFileSync(join(HERE, file)))
	}
	writeFileSync(join(scratch, 'cluster-access.mjs'), readFileSync(join(SANDBOX_PKG, 'k8s/scripts/lib/cluster-access.mjs')))
	mkdirSync(join(scratch, 'k8s-scripts', 'lib'), { recursive: true })
	for (const file of ['acquire-p50.mjs', 'capability-check.mjs']) {
		writeFileSync(join(scratch, 'k8s-scripts', file), readFileSync(join(SANDBOX_PKG, 'k8s/scripts', file)))
	}
	writeFileSync(
		join(scratch, 'k8s-scripts', 'lib', 'cluster-access.mjs'),
		readFileSync(join(SANDBOX_PKG, 'k8s/scripts/lib/cluster-access.mjs')),
	)

	const tarGzPath = join(scratch, '..', 'runner.tar.gz')
	execFileSync('tar', [
		'-czf',
		tarGzPath,
		'-C',
		scratch,
		'node_modules',
		'package.json',
		'package-lock.json',
		'cluster-access.mjs',
		'runner.mjs',
		'lease-holder.mjs',
		'k8s-scripts',
		'Dockerfile',
	])

	await wslCurlFetch(tarGzPath, '/root/runner.tar.gz')
	wsl('rm -rf /root/runner-ctx && mkdir -p /root/runner-ctx && tar -xzf /root/runner.tar.gz -C /root/runner-ctx', {
		timeoutMs: 60_000,
	})
	wsl('cd /root/runner-ctx && podman build -t namzu-e2e-runner:kind .', { timeoutMs: 300_000 })
	wsl('rm -f /root/runner-image.tar && podman save localhost/namzu-e2e-runner:kind -o /root/runner-image.tar', {
		timeoutMs: 120_000,
	})
	wsl(`KIND_EXPERIMENTAL_PROVIDER=podman kind load image-archive /root/runner-image.tar --name ${KIND_CLUSTER}`, {
		timeoutMs: 120_000,
	})
	rmSync(scratch, { recursive: true, force: true })
	rmSync(tarGzPath, { force: true })
	log('runner image loaded as localhost/namzu-e2e-runner:kind')
}

// ---------------------------------------------------------------------------
// apply — kind overlay, rebased into namespace namzu-e2e
// ---------------------------------------------------------------------------
function apply() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-overlay-'))
	// A directory `resources:` entry establishes a NEW kustomize root, which
	// refuses an absolute path outright — pre-render the checked-in overlay
	// (untouched) to a single file first, which has no such restriction.
	const baseRendered = kubectl([
		'kustomize',
		'--load-restrictor=LoadRestrictionsNone',
		join(SANDBOX_PKG, 'k8s', 'manifests', 'kind-overlay'),
	])
	writeFileSync(join(scratch, 'base-rendered.yaml'), baseRendered)
	writeFileSync(join(scratch, 'namespace.yaml'), `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${NAMESPACE}\n`)
	writeFileSync(
		join(scratch, 'kustomization.yaml'),
		[
			'apiVersion: kustomize.config.k8s.io/v1beta1',
			'kind: Kustomization',
			`namespace: ${NAMESPACE}`,
			'resources:',
			'  - namespace.yaml',
			'  - base-rendered.yaml',
			'images:',
			'  - name: namzu-sandbox-agent',
			'    newName: localhost/namzu-sandbox-agent',
			'    newTag: kind',
			'',
		].join('\n'),
	)
	const rendered = kubectl(['kustomize', scratch])
	writeFileSync(join(scratch, 'final-rendered.yaml'), rendered)
	kubectl(['apply', '-f', join(scratch, 'final-rendered.yaml')])

	log('waiting for the warm pool...')
	const deadline = Date.now() + 120_000
	for (;;) {
		const ready = kubectl([
			'-n',
			NAMESPACE,
			'get',
			'sandboxwarmpool',
			'namzu-task-pool',
			'-o',
			'jsonpath={.status.readyReplicas}/{.status.replicas}',
		]).trim()
		log(`  pool: ${ready}`)
		const [have, want] = ready.split('/').map(Number)
		if (have >= want && want > 0) break
		if (Date.now() > deadline) throw new Error(`warm pool never became ready (last: ${ready})`)
		spawnSync('sleep', ['3'])
	}
	rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// run — the runner Job
// ---------------------------------------------------------------------------
function waitForJob(name, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const succeeded = kubectl(['-n', NAMESPACE, 'get', 'job', name, '-o', 'jsonpath={.status.succeeded}']).trim()
		const failed = kubectl(['-n', NAMESPACE, 'get', 'job', name, '-o', 'jsonpath={.status.failed}']).trim()
		if (succeeded || failed) return { succeeded: Boolean(succeeded), failed: Boolean(failed) }
		if (Date.now() > deadline) throw new Error(`job/${name} did not finish within ${timeoutMs}ms`)
		spawnSync('sleep', ['10'])
	}
}

function run() {
	kubectl(['apply', '-f', join(HERE, 'manifests', 'runner-job.yaml')])
	const outcome = waitForJob('namzu-e2e-runner', 900_000)
	const logs = kubectl(['-n', NAMESPACE, 'logs', 'job/namzu-e2e-runner'])
	writeFileSync(join(HERE, '.runner-job.log'), logs)
	log('runner job outcome:', outcome)
	return logs
}

function runW8() {
	kubectl(['apply', '-f', join(HERE, 'manifests', 'w8-scripts-job.yaml')])
	const outcome = waitForJob('namzu-e2e-w8-scripts', 300_000)
	const logs = kubectl(['-n', NAMESPACE, 'logs', 'job/namzu-e2e-w8-scripts'])
	writeFileSync(join(HERE, '.w8-scripts-job.log'), logs)
	log('w8-scripts job outcome:', outcome)
	return logs
}

// ---------------------------------------------------------------------------
// collect — assemble kind-e2e-results.json from both jobs' logs
// ---------------------------------------------------------------------------
function collect(runnerLog, w8Log) {
	const start = runnerLog.indexOf('=== RESULTS_JSON_START ===')
	const end = runnerLog.indexOf('=== RESULTS_JSON_END ===')
	if (start === -1 || end === -1) throw new Error('runner job log has no RESULTS_JSON block')
	const runnerResults = JSON.parse(runnerLog.slice(start + '=== RESULTS_JSON_START ==='.length, end))

	const acquireP50Line = w8Log.split('\n').find((l) => l.startsWith('acquire-p50:'))
	const capabilityLine = w8Log.split('\n').find((l) => l.startsWith('capability-check:'))

	const combined = {
		collectedAt: new Date().toISOString(),
		cluster: {
			kind: KIND_CLUSTER,
			kubernetesVersion: kubectl(['version', '-o', 'json'])
				? JSON.parse(kubectl(['version', '-o', 'json'])).serverVersion.gitVersion
				: undefined,
			controllerImage: kubectl([
				'-n',
				'agent-sandbox-system',
				'get',
				'deploy',
				'agent-sandbox-controller',
				'-o',
				'jsonpath={.spec.template.spec.containers[0].image}',
			]),
		},
		runner: runnerResults,
		w8Scripts: {
			acquireP50Summary: acquireP50Line,
			capabilityCheckSummary: capabilityLine,
			rawLog: w8Log,
		},
	}
	writeFileSync(join(HERE, 'kind-e2e-results.json'), JSON.stringify(combined, null, 2))
	log('wrote', join(HERE, 'kind-e2e-results.json'))
	return combined
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------
function cleanup() {
	kubectl(['delete', 'namespace', NAMESPACE, '--wait=true'])
	log(`namespace ${NAMESPACE} deleted; cluster, controller and loaded images left running`)
}

// ---------------------------------------------------------------------------
async function main() {
	const command = process.argv[2]
	switch (command) {
		case 'build-agent-image':
			return await buildAgentImage()
		case 'build-runner-image':
			return await buildRunnerImage()
		case 'apply':
			return apply()
		case 'run':
			return void run()
		case 'run-w8':
			return void runW8()
		case 'collect': {
			const runnerLog = readFileSync(join(HERE, '.runner-job.log'), 'utf8')
			const w8Log = readFileSync(join(HERE, '.w8-scripts-job.log'), 'utf8')
			return void collect(runnerLog, w8Log)
		}
		case 'cleanup':
			return cleanup()
		case 'all': {
			await buildAgentImage()
			await buildRunnerImage()
			apply()
			const runnerLog = run()
			const w8Log = runW8()
			collect(runnerLog, w8Log)
			cleanup()
			return
		}
		default:
			console.error(
				'usage: node kind-e2e-cli.mjs <build-agent-image|build-runner-image|apply|run|run-w8|collect|cleanup|all>',
			)
			process.exit(1)
	}
}

await main()
