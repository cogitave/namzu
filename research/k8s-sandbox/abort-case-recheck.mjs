#!/usr/bin/env node
/**
 * Re-runs the full W9 conformance suite in-cluster against a guest image
 * built from THIS worktree's `k8s/Dockerfile` / `k8s/entrypoint.sh` — the
 * ones that now install and exec into `tini` as the container's PID 1 —
 * to check in issue #469's abort-case final round as a reproducible script
 * plus data, rather than as prose alone.
 *
 * Reuses `tcp-case-recheck.mjs`'s own mechanics (async `wsl()` /
 * `wslCurlFetch()` — the earlier `kind-e2e-cli.mjs` versions are
 * `spawnSync`-blocking and self-deadlock a local HTTP transfer server, see
 * that file's own header) rather than duplicating them from scratch. What
 * is DIFFERENT here:
 *
 *   - This is the only one of the three recheck scripts in this directory
 *     that rebuilds the AGENT image, not just the runner image — the whole
 *     point is to exercise the NEW `k8s/Dockerfile`/`entrypoint.sh`, not
 *     whatever `namzu-sandbox-agent:kind`/`:kind-fixed` tag a previous
 *     round already loaded.
 *   - A dedicated namespace (`namzu-e2e-abort469` by default) and a
 *     dedicated agent image tag (`namzu-sandbox-agent:kind-tini469`),
 *     applied and torn down independently of any other namespace/tag a
 *     concurrent session might be using.
 *   - The runner image bundles `abort-case-runner.mjs` (poolWarm +
 *     conformance, timed per case) rather than `tcp-case-runner.mjs`.
 *
 * Usage: node research/k8s-sandbox/abort-case-recheck.mjs <build|apply|run|collect|cleanup|all>
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SANDBOX_PKG = join(REPO_ROOT, 'packages', 'sandbox')
const NAMESPACE = process.env.NAMZU_ABORT_RECHECK_NAMESPACE ?? 'namzu-e2e-abort469'
const AGENT_IMAGE_TAG = 'namzu-sandbox-agent:kind-tini469'
const RUNNER_IMAGE_TAG = 'namzu-e2e-abort-runner:kind'
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe'
const PODMAN_MACHINE = 'podman-machine-default'
const KIND_CLUSTER = 'namzu'

function log(...args) {
	console.log(new Date().toISOString(), ...args)
}

/** Async (non-blocking) `wsl -d podman-machine-default` — see this file's own header for why. */
function wsl(cmd, { timeoutMs = 120_000 } = {}) {
	log('[wsl]', cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd)
	return new Promise((resolve, reject) => {
		const child = spawn(WSL_EXE, ['-d', PODMAN_MACHINE, '-u', 'root', '--', 'sh', '-lc', cmd], {
			stdio: ['ignore', 'pipe', 'pipe'],
			cwd: '/',
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
		}, timeoutMs)
		child.once('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.once('close', (code) => {
			clearTimeout(timer)
			const out = stdout.replace(/\r/g, '')
			const err = stderr.replace(/\r/g, '')
			const meaningfulErr = err.replace(/^wsl: Failed to translate '[^']*'\n?/, '')
			if (code !== 0) {
				reject(new Error(`wsl command failed (exit ${code}): ${cmd}\n${out}\n${meaningfulErr}`))
				return
			}
			if (meaningfulErr.trim()) log('[wsl:stderr]', meaningfulErr.trim())
			resolve(out)
		})
	})
}

function kubectl(args, opts = {}) {
	log('[kubectl]', args.join(' '))
	return execFileSync('kubectl', args, { encoding: 'utf8', ...opts })
}

/** Same shared-loopback transfer trick as `tcp-case-recheck.mjs`'s `wslCurlFetch`. */
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
		await wsl(`curl -s -o ${remotePath} http://127.0.0.1:${port}/payload && sha256sum ${remotePath}`, {
			timeoutMs: 60_000,
		})
		const remoteSha = (await wsl(`sha256sum ${remotePath}`)).split(' ')[0]
		if (remoteSha !== localSha) {
			throw new Error(`transfer checksum mismatch for ${filePath}: local ${localSha} remote ${remoteSha}`)
		}
	} finally {
		server.close()
	}
}

// ---------------------------------------------------------------------------
// buildAgentImage — packages/sandbox/k8s/Dockerfile from THIS worktree
// (tini installed, entrypoint execs into it), tagged AGENT_IMAGE_TAG.
// ---------------------------------------------------------------------------
async function buildAgentImage() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-abort-agent-ctx-'))
	const tarPath = join(scratch, 'agent-ctx.tar')
	// Build context is exactly what k8s/Dockerfile COPYs — see that file's
	// own header: agent/agent.cjs and k8s/entrypoint.sh, both siblings of
	// k8s/Dockerfile under packages/sandbox.
	execFileSync('tar', ['-cf', tarPath, '-C', SANDBOX_PKG, 'agent/agent.cjs', 'k8s/Dockerfile', 'k8s/entrypoint.sh'])
	await wslCurlFetch(tarPath, '/root/abort-agent-ctx.tar')
	await wsl(`podman build -f k8s/Dockerfile -t ${AGENT_IMAGE_TAG} - < /root/abort-agent-ctx.tar`, {
		timeoutMs: 300_000,
	})
	await wsl(`rm -f /root/abort-agent-image.tar && podman save localhost/${AGENT_IMAGE_TAG} -o /root/abort-agent-image.tar`, {
		timeoutMs: 120_000,
	})
	await wsl(`KIND_EXPERIMENTAL_PROVIDER=podman kind load image-archive /root/abort-agent-image.tar --name ${KIND_CLUSTER}`, {
		timeoutMs: 120_000,
	})
	rmSync(scratch, { recursive: true, force: true })
	log(`agent image loaded as localhost/${AGENT_IMAGE_TAG}`)
}

// ---------------------------------------------------------------------------
// buildRunnerImage — pack @namzu/sdk + @namzu/sandbox FROM THIS WORKTREE,
// assemble a runner image carrying abort-case-runner.mjs.
// ---------------------------------------------------------------------------
async function buildRunnerImage() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-abort-runner-'))
	const tarballsDir = join(scratch, 'tarballs')
	mkdirSync(tarballsDir, { recursive: true })

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
				name: 'namzu-k8s-abort-recheck-runner',
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

	writeFileSync(join(scratch, 'abort-case-runner.mjs'), readFileSync(join(HERE, 'abort-case-runner.mjs')))
	writeFileSync(
		join(scratch, 'Dockerfile'),
		[
			'FROM node:22-bookworm-slim',
			'WORKDIR /app',
			'COPY node_modules ./node_modules',
			'COPY package.json package-lock.json ./',
			'COPY cluster-access.mjs abort-case-runner.mjs ./',
			'CMD ["node", "abort-case-runner.mjs"]',
			'',
		].join('\n'),
	)
	writeFileSync(join(scratch, 'cluster-access.mjs'), readFileSync(join(SANDBOX_PKG, 'k8s/scripts/lib/cluster-access.mjs')))

	const tarGzPath = join(scratch, '..', 'abort-recheck-runner.tar.gz')
	execFileSync('tar', [
		'-czf',
		tarGzPath,
		'-C',
		scratch,
		'node_modules',
		'package.json',
		'package-lock.json',
		'cluster-access.mjs',
		'abort-case-runner.mjs',
		'Dockerfile',
	])

	await wslCurlFetch(tarGzPath, '/root/abort-recheck-runner.tar.gz')
	await wsl(
		'rm -rf /root/abort-recheck-ctx && mkdir -p /root/abort-recheck-ctx && tar -xzf /root/abort-recheck-runner.tar.gz -C /root/abort-recheck-ctx',
		{ timeoutMs: 60_000 },
	)
	await wsl(`cd /root/abort-recheck-ctx && podman build -t ${RUNNER_IMAGE_TAG} .`, { timeoutMs: 300_000 })
	await wsl(`rm -f /root/abort-recheck-runner-image.tar && podman save localhost/${RUNNER_IMAGE_TAG} -o /root/abort-recheck-runner-image.tar`, {
		timeoutMs: 120_000,
	})
	await wsl(
		`KIND_EXPERIMENTAL_PROVIDER=podman kind load image-archive /root/abort-recheck-runner-image.tar --name ${KIND_CLUSTER}`,
		{ timeoutMs: 120_000 },
	)
	rmSync(scratch, { recursive: true, force: true })
	rmSync(tarGzPath, { force: true })
	log(`runner image loaded as localhost/${RUNNER_IMAGE_TAG}`)
}

async function build() {
	await buildAgentImage()
	await buildRunnerImage()
}

// ---------------------------------------------------------------------------
// apply — the same kind-overlay kind-e2e-cli.mjs/tcp-case-recheck.mjs apply,
// rebased into NAMESPACE, image rewritten to the tini-bearing agent tag.
// ---------------------------------------------------------------------------
function apply() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-abort-recheck-overlay-'))
	const baseRendered = kubectl([
		'kustomize',
		'--load-restrictor=LoadRestrictionsNone',
		join(SANDBOX_PKG, 'k8s', 'manifests', 'kind-overlay'),
	])
	writeFileSync(join(scratch, 'base-rendered.yaml'), baseRendered)
	writeFileSync(join(scratch, 'namespace.yaml'), `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${NAMESPACE}\n`)
	const [agentName, agentTag] = AGENT_IMAGE_TAG.split(':')
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
			`  - name: ${agentName}`,
			`    newName: localhost/${agentName}`,
			`    newTag: ${agentTag}`,
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
// run — a Job in NAMESPACE running abort-case-runner.mjs.
// ---------------------------------------------------------------------------
function waitForJob(name, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const succeeded = kubectl(['-n', NAMESPACE, 'get', 'job', name, '-o', 'jsonpath={.status.succeeded}']).trim()
		const failed = kubectl(['-n', NAMESPACE, 'get', 'job', name, '-o', 'jsonpath={.status.failed}']).trim()
		if (succeeded || failed) return { succeeded: Boolean(succeeded), failed: Boolean(failed) }
		if (Date.now() > deadline) throw new Error(`job/${name} did not finish within ${timeoutMs}ms`)
		spawnSync('sleep', ['5'])
	}
}

function run() {
	const jobName = 'namzu-abort-case-recheck'
	const manifest = [
		'apiVersion: batch/v1',
		'kind: Job',
		'metadata:',
		`  name: ${jobName}`,
		`  namespace: ${NAMESPACE}`,
		'spec:',
		'  backoffLimit: 0',
		'  activeDeadlineSeconds: 300',
		'  template:',
		'    metadata:',
		'      labels:',
		'        namzu.ai/component: host',
		'    spec:',
		'      serviceAccountName: namzu-sandbox-host',
		'      restartPolicy: Never',
		'      containers:',
		'        - name: runner',
		`          image: localhost/${RUNNER_IMAGE_TAG}`,
		'          imagePullPolicy: IfNotPresent',
		'          env:',
		'            - name: NAMZU_E2E_NAMESPACE',
		`              value: ${NAMESPACE}`,
		'            - name: NAMZU_E2E_TEMPLATE',
		'              value: namzu-task',
		'            - name: NAMZU_E2E_POOL',
		'              value: namzu-task-pool',
		'',
	].join('\n')
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-abort-recheck-job-'))
	const manifestPath = join(scratch, 'job.yaml')
	writeFileSync(manifestPath, manifest)
	kubectl(['apply', '-f', manifestPath])
	const outcome = waitForJob(jobName, 240_000)
	const logs = kubectl(['-n', NAMESPACE, 'logs', `job/${jobName}`])
	writeFileSync(join(HERE, '.abort-case-recheck-job.log'), logs)
	rmSync(scratch, { recursive: true, force: true })
	log('abort-case-recheck job outcome:', outcome)
	return logs
}

// ---------------------------------------------------------------------------
// collect — extract RESULTS_JSON from the job log
// ---------------------------------------------------------------------------
function collect(runnerLog) {
	const start = runnerLog.indexOf('=== RESULTS_JSON_START ===')
	const end = runnerLog.indexOf('=== RESULTS_JSON_END ===')
	if (start === -1 || end === -1) throw new Error('runner job log has no RESULTS_JSON block')
	const runnerResults = JSON.parse(runnerLog.slice(start + '=== RESULTS_JSON_START ==='.length, end))
	const combined = {
		collectedAt: new Date().toISOString(),
		purpose: runnerResults.purpose,
		cluster: {
			kind: KIND_CLUSTER,
			kubernetesVersion: JSON.parse(kubectl(['version', '-o', 'json'])).serverVersion.gitVersion,
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
		namespace: NAMESPACE,
		agentImageTag: AGENT_IMAGE_TAG,
		runnerImageTag: RUNNER_IMAGE_TAG,
		runner: runnerResults,
	}
	const outPath = join(HERE, 'abort-case-recheck-results.json')
	writeFileSync(outPath, JSON.stringify(combined, null, 2))
	log('wrote', outPath)
	return combined
}

// ---------------------------------------------------------------------------
// cleanup — delete the dedicated namespace only. Cluster/controller/other
// loaded images are left untouched.
// ---------------------------------------------------------------------------
function cleanup() {
	kubectl(['delete', 'namespace', NAMESPACE, '--wait=true'])
	log(`namespace ${NAMESPACE} deleted; cluster, controller and loaded images left running`)
}

async function main() {
	const command = process.argv[2]
	switch (command) {
		case 'build':
			return await build()
		case 'apply':
			return apply()
		case 'run':
			return void run()
		case 'collect': {
			const runnerLog = readFileSync(join(HERE, '.abort-case-recheck-job.log'), 'utf8')
			return void collect(runnerLog)
		}
		case 'cleanup':
			return cleanup()
		case 'all': {
			await build()
			apply()
			const runnerLog = run()
			collect(runnerLog)
			cleanup()
			return
		}
		default:
			console.error('usage: node abort-case-recheck.mjs <build|apply|run|collect|cleanup|all>')
			process.exit(1)
	}
}

await main()
