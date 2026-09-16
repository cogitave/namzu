#!/usr/bin/env node
/**
 * Re-runs ONLY the conformance phase of the W10 kind end-to-end run, against
 * the FIXED `openTcpConnection` positive case (issue #469, TCP sub-task) —
 * to confirm in-cluster, against a real remote guest, what the local vitest
 * suite already confirmed against the two colocated fixtures.
 *
 * Reuses `kind-e2e-cli.mjs`'s own mechanics (same podman-machine transfer
 * trick, same kind-overlay, same warm pool) rather than duplicating them
 * from scratch — see that file's own header for the environment this is
 * tied to. What is deliberately DIFFERENT here, to avoid disturbing the
 * original run's record or any sibling run using the shared `namzu-e2e`
 * namespace and `namzu-e2e-runner:kind` image tag at the same time:
 *
 *   - A dedicated namespace (`namzu-e2e-tcp469` by default), applied and
 *     torn down independently of `namzu-e2e`.
 *   - A dedicated image tag (`namzu-e2e-tcp-runner:kind`), built from a
 *     runner image whose CMD is unchanged (`node runner.mjs`) but whose
 *     build context also carries `tcp-case-runner.mjs` — the reduced
 *     poolWarm+conformance-only driver this Job actually runs, via a
 *     `command` override in its own Job manifest.
 *   - The npm tarballs packed into that image come from the sdk/sandbox
 *     packages IN THIS WORKTREE (`packages/sdk`, `packages/sandbox`), not
 *     wherever `kind-e2e-cli.mjs` last built from — this is the whole
 *     point: the image has to carry the FIXED suite, not the one that
 *     failed on 2026-09-15.
 *
 * Usage: node research/k8s-sandbox/tcp-case-recheck.mjs <build|apply|run|cleanup|all>
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
const NAMESPACE = process.env.NAMZU_TCP_RECHECK_NAMESPACE ?? 'namzu-e2e-tcp469'
const IMAGE_TAG = 'namzu-e2e-tcp-runner:kind'
const WSL_EXE = '/mnt/c/Windows/System32/wsl.exe'
const PODMAN_MACHINE = 'podman-machine-default'
const KIND_CLUSTER = 'namzu'

function log(...args) {
	console.log(new Date().toISOString(), ...args)
}

/**
 * Same command shape as `kind-e2e-cli.mjs`'s own `wsl()` (foreground, a
 * generous timeout, no stdin) but ASYNC rather than `spawnSync`-blocking —
 * load-bearing here specifically for `wslCurlFetch` below: a `spawnSync`
 * call halts this process's entire event loop, including the very HTTP
 * server `wslCurlFetch` stood up to answer the WSL side's `curl`, which
 * deadlocks the transfer until `spawnSync`'s own timeout kills it (observed
 * directly: every call through `wslCurlFetch` timed out at exactly the
 * configured `timeoutMs` until this was switched to `spawn`). Every OTHER
 * caller here still awaits each call before issuing the next, so control
 * flow stays exactly as sequential as the synchronous original.
 */
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

/** Same shared-loopback transfer trick as `kind-e2e-cli.mjs`'s `wslCurlFetch`. */
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
// build — pack @namzu/sdk + @namzu/sandbox FROM THIS WORKTREE, assemble the
// runner image (runner.mjs unmodified + this task's tcp-case-runner.mjs),
// load into kind as IMAGE_TAG. Mirrors kind-e2e-cli.mjs's buildRunnerImage().
// ---------------------------------------------------------------------------
async function build() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-tcp-recheck-'))
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
				name: 'namzu-k8s-tcp-recheck-runner',
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

	for (const file of ['runner.mjs', 'lease-holder.mjs', 'tcp-case-runner.mjs']) {
		writeFileSync(join(scratch, file), readFileSync(join(HERE, file)))
	}
	// Not `research/k8s-sandbox/Dockerfile` verbatim: that file's own COPY
	// list has no reason to know about this task's `tcp-case-runner.mjs`,
	// so this build carries its own copy with one extra line rather than
	// editing the shared research artifact for a one-off recheck.
	writeFileSync(
		join(scratch, 'Dockerfile'),
		[
			'FROM node:22-bookworm-slim',
			'WORKDIR /app',
			'COPY node_modules ./node_modules',
			'COPY package.json package-lock.json ./',
			'COPY cluster-access.mjs runner.mjs lease-holder.mjs tcp-case-runner.mjs ./',
			'COPY k8s-scripts ./k8s-scripts',
			'CMD ["node", "runner.mjs"]',
			'',
		].join('\n'),
	)
	writeFileSync(join(scratch, 'cluster-access.mjs'), readFileSync(join(SANDBOX_PKG, 'k8s/scripts/lib/cluster-access.mjs')))
	mkdirSync(join(scratch, 'k8s-scripts', 'lib'), { recursive: true })
	for (const file of ['acquire-p50.mjs', 'capability-check.mjs']) {
		writeFileSync(join(scratch, 'k8s-scripts', file), readFileSync(join(SANDBOX_PKG, 'k8s/scripts', file)))
	}
	writeFileSync(
		join(scratch, 'k8s-scripts', 'lib', 'cluster-access.mjs'),
		readFileSync(join(SANDBOX_PKG, 'k8s/scripts/lib/cluster-access.mjs')),
	)

	const tarGzPath = join(scratch, '..', 'tcp-recheck-runner.tar.gz')
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
		'tcp-case-runner.mjs',
		'k8s-scripts',
		'Dockerfile',
	])

	await wslCurlFetch(tarGzPath, '/root/tcp-recheck-runner.tar.gz')
	await wsl(
		'rm -rf /root/tcp-recheck-ctx && mkdir -p /root/tcp-recheck-ctx && tar -xzf /root/tcp-recheck-runner.tar.gz -C /root/tcp-recheck-ctx',
		{ timeoutMs: 60_000 },
	)
	await wsl(`cd /root/tcp-recheck-ctx && podman build -t ${IMAGE_TAG} .`, { timeoutMs: 300_000 })
	await wsl(`rm -f /root/tcp-recheck-runner-image.tar && podman save localhost/${IMAGE_TAG} -o /root/tcp-recheck-runner-image.tar`, {
		timeoutMs: 120_000,
	})
	await wsl(`KIND_EXPERIMENTAL_PROVIDER=podman kind load image-archive /root/tcp-recheck-runner-image.tar --name ${KIND_CLUSTER}`, {
		timeoutMs: 120_000,
	})
	rmSync(scratch, { recursive: true, force: true })
	rmSync(tarGzPath, { force: true })
	log(`runner image loaded as localhost/${IMAGE_TAG}`)
}

// ---------------------------------------------------------------------------
// apply — the same kind-overlay kind-e2e-cli.mjs applies, rebased into
// NAMESPACE instead of namzu-e2e.
// ---------------------------------------------------------------------------
function apply() {
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-tcp-recheck-overlay-'))
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
// run — a Job in NAMESPACE running tcp-case-runner.mjs (command override on
// the built image, whose CMD is still `node runner.mjs`).
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
	const jobName = 'namzu-tcp-case-recheck'
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
		`          image: localhost/${IMAGE_TAG}`,
		'          imagePullPolicy: IfNotPresent',
		'          command: ["node", "tcp-case-runner.mjs"]',
		'          env:',
		'            - name: NAMZU_E2E_NAMESPACE',
		`              value: ${NAMESPACE}`,
		'            - name: NAMZU_E2E_TEMPLATE',
		'              value: namzu-task',
		'            - name: NAMZU_E2E_POOL',
		'              value: namzu-task-pool',
		'',
	].join('\n')
	const scratch = mkdtempSync(join(tmpdir(), 'namzu-tcp-recheck-job-'))
	const manifestPath = join(scratch, 'job.yaml')
	writeFileSync(manifestPath, manifest)
	kubectl(['apply', '-f', manifestPath])
	const outcome = waitForJob(jobName, 240_000)
	const logs = kubectl(['-n', NAMESPACE, 'logs', `job/${jobName}`])
	writeFileSync(join(HERE, '.tcp-case-recheck-job.log'), logs)
	rmSync(scratch, { recursive: true, force: true })
	log('tcp-case-recheck job outcome:', outcome)
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
		imageTag: IMAGE_TAG,
		runner: runnerResults,
	}
	const outPath = join(HERE, 'tcp-case-recheck-results.json')
	writeFileSync(outPath, JSON.stringify(combined, null, 2))
	log('wrote', outPath)
	return combined
}

// ---------------------------------------------------------------------------
// cleanup — delete the dedicated namespace only. Cluster/controller/images
// (including the ORIGINAL namzu-e2e-runner:kind tag) are left untouched.
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
			const runnerLog = readFileSync(join(HERE, '.tcp-case-recheck-job.log'), 'utf8')
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
			console.error('usage: node tcp-case-recheck.mjs <build|apply|run|collect|cleanup|all>')
			process.exit(1)
	}
}

await main()
