/**
 * `walkFiles` on a kubernetes task sandbox, against the REAL guest agent
 * (`agent/agent.cjs`) on a loopback TCP socket, over a real filesystem.
 *
 * The method is not a new wire op: it is the SDK's own `walkFilesViaExec`
 * running the SDK's walk program as `node -e` inside the guest, streaming one
 * JSONL record per match back over an ordinary `execute`. So the thing worth
 * proving here is not the traversal semantics — `@namzu/sdk`'s own
 * `file-walk` suites own those — but that this backend wires the enumerator
 * to a real guest correctly, end to end: the bounds arrive, the records come
 * back parsed, a failure the guest reports keeps its code, and, above all,
 * that stopping the iteration really stops the PROCESS in the guest rather
 * than abandoning it there.
 *
 * That last one is the reason this file uses a 12,000-file fixture where a
 * handful of files would have exercised every other assertion, and the reason
 * the cancellation cases MEASURE. "No walk process afterwards" is true of a
 * walk that was killed and equally true of one that was simply allowed to
 * finish, so a fixture big enough to still be walking at the break buys the
 * positive control (the process is there to kill) and, with the uninterrupted
 * walk timed on this machine, a window a backend that ignored the
 * cancellation could not possibly land in. Both are asserted; neither is
 * assumed.
 *
 * Why `/proc` and not a marker file: the walk program is fixed SDK code and
 * cannot be asked to leave evidence behind the way the conformance suite's
 * abort case has its shell script do. The process table is the only place the
 * answer lives. The guest here IS this host, so the scan is narrowed to
 * cmdlines carrying the walk's own root path — which the plan JSON puts in
 * the walk process's argv and nothing else on this machine has.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Sandbox, SandboxFileEntry, SandboxWalkFilesOptions } from '@namzu/sdk'
import { GlobTool, GrepTool } from '@namzu/sdk'
import type { ToolContext } from '@namzu/sdk'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { KubernetesAlreadyGoneError, createKubernetesClient } from '../k8s-client.js'
import { claimPath } from '../objects.js'
import { type KubernetesSandboxHandle, buildKubernetesSandbox } from '../sandbox.js'
import { KubernetesAgentTransport } from '../transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { type FakeApiServer, startFakeApiServer } from './fixtures/fake-api-server.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'
const NAMESPACE = 'namzu-sandboxes'
const CLAIM_NAME = 'namzu-task-4a1f9c22-0b7e-4f3a-9c10-5d2e6b8f0a41'
const SANDBOX_NAME = 'namzu-task-pool-sandbox-walk'
const POD_UID = '5c2b1a90-3e47-4d18-8b62-71f0c9ad3e55'

/**
 * Big enough that a walk over it is still running when the consumer stops
 * after five entries (measured: ~0.8 s for the traversal, against a
 * round-trip `exec` of tens of milliseconds), and the same order of magnitude
 * the issue's own acceptance names for the builtin-tool comparison.
 */
const BIG_FIXTURE_DIRS = 120
const BIG_FIXTURE_FILES_PER_DIR = 100
const BIG_FIXTURE_TOTAL = BIG_FIXTURE_DIRS * BIG_FIXTURE_FILES_PER_DIR

interface AgentModule {
	startListening(): Promise<Server>
}

let workDir: string
let listener: Server | undefined
let server: FakeApiServer | undefined
let saved: Record<string, string | undefined>
let savedPath: string | undefined
/** Built once for the whole file: 12,000 files is ~0.6 s of mkdir/write. */
let bigFixture: string

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) delete process.env[key]
}

/** A FRESH agent module per case, so module-level bind-token state never leaks. */
async function startAgent(root: string): Promise<number> {
	process.env.NAMZU_SANDBOX_WORKSPACE = root
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	listener = await agent.startListening()
	return (listener.address() as AddressInfo).port
}

/**
 * `root` is the guest's workspace AND the handle's `rootDir`, because the
 * agent jails `readFile`/`writeFile` to its workspace: a case that searches
 * the shared big fixture has to have the guest rooted there, not in this
 * case's own scratch directory.
 */
async function build(root: string = workDir): Promise<KubernetesSandboxHandle> {
	const port = await startAgent(root)
	server = await startFakeApiServer((req) => {
		if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
		if (req.method === 'PATCH') return { status: 200, body: {} }
		return { status: 404, body: {} }
	})
	const client = createKubernetesClient({
		server: server.url,
		namespace: NAMESPACE,
		getToken: async () => 'sa-token',
	})
	const ownedPath = claimPath(NAMESPACE, CLAIM_NAME)
	return buildKubernetesSandbox({
		name: SANDBOX_NAME,
		rootDir: root,
		transport: new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		}),
		release: async (signal) => {
			try {
				await client.request('DELETE', ownedPath, undefined, signal)
			} catch (error) {
				if (!(error instanceof KubernetesAlreadyGoneError)) throw error
			}
		},
		renew: async (shutdownTime, signal) => {
			await client.request('PATCH', ownedPath, { spec: { lifecycle: { shutdownTime } } }, signal)
		},
		// An hour: no renewal tick fires inside a case here.
		ttlSeconds: 3_600,
	})
}

async function collect(
	sandbox: Sandbox,
	root: string,
	options: SandboxWalkFilesOptions,
): Promise<string[]> {
	const walkFiles = sandbox.walkFiles
	if (!walkFiles) throw new Error('the kubernetes sandbox must implement walkFiles')
	const paths: string[] = []
	for await (const entry of walkFiles.call(sandbox, root, options)) paths.push(entry.path)
	return paths.sort()
}

beforeAll(() => {
	bigFixture = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-walk-big-')))
	for (let dir = 0; dir < BIG_FIXTURE_DIRS; dir += 1) {
		const directory = join(bigFixture, `d${dir}`)
		mkdirSync(directory)
		for (let file = 0; file < BIG_FIXTURE_FILES_PER_DIR; file += 1) {
			writeFileSync(join(directory, `f${file}.txt`), `${dir}:${file}\n`)
		}
	}
})

afterAll(() => {
	rmSync(bigFixture, { recursive: true, force: true })
})

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	savedPath = process.env.PATH
	clearEnv(AGENT_ENV_KEYS)
	// The guest's TERM→KILL escalation, shortened so a cancellation case
	// spends 50 ms proving the kill rather than the production two seconds.
	process.env.NAMZU_AGENT_CANCEL_GRACE_MS = '50'
	process.env.NAMZU_AGENT_CANCEL_CONFIRM_TIMEOUT_MS = '1000'
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-walk-files-')))
})

afterEach(async () => {
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	await server?.close()
	server = undefined
	clearEnv(AGENT_ENV_KEYS)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	if (savedPath !== undefined) process.env.PATH = savedPath
	rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('walkFiles on a kubernetes task sandbox', () => {
	it('enumerates the guest filesystem as absolute paths, honouring maxEntries', async () => {
		const sandbox = await build()
		mkdirSync(join(workDir, 'src'), { recursive: true })
		writeFileSync(join(workDir, 'src', 'a.ts'), 'a')
		writeFileSync(join(workDir, 'src', 'b.ts'), 'bb')
		writeFileSync(join(workDir, 'src', 'c.ts'), 'ccc')

		const all = await collect(sandbox, workDir, { maxEntries: 100, pattern: '**/*.ts' })
		expect(all).toEqual([
			join(workDir, 'src', 'a.ts'),
			join(workDir, 'src', 'b.ts'),
			join(workDir, 'src', 'c.ts'),
		])

		// The bound is a bound on what is EMITTED, and it is the guest that
		// stops: the host never sees a fourth record to discard.
		const bounded = await collect(sandbox, workDir, { maxEntries: 2, pattern: '**/*.ts' })
		expect(bounded.length).toBe(2)
		await sandbox.destroy()
	})

	it('reports each entry with the size the guest sees', async () => {
		const sandbox = await build()
		writeFileSync(join(workDir, 'sized.bin'), Buffer.alloc(4_097, 7))
		const entries: SandboxFileEntry[] = []
		for await (const entry of sandbox.walkFiles(workDir, { maxEntries: 10, pattern: '*.bin' })) {
			entries.push(entry)
		}
		expect(entries).toEqual([{ path: join(workDir, 'sized.bin'), size: 4_097 }])
		await sandbox.destroy()
	})

	it('bounds the descent with maxDepth', async () => {
		const sandbox = await build()
		mkdirSync(join(workDir, 'one', 'two'), { recursive: true })
		writeFileSync(join(workDir, 'top.txt'), 'top')
		writeFileSync(join(workDir, 'one', 'mid.txt'), 'mid')
		writeFileSync(join(workDir, 'one', 'two', 'deep.txt'), 'deep')

		expect(await collect(sandbox, workDir, { maxEntries: 100, maxDepth: 1 })).toEqual([
			join(workDir, 'top.txt'),
		])
		expect(await collect(sandbox, workDir, { maxEntries: 100, maxDepth: 2 })).toEqual([
			join(workDir, 'one', 'mid.txt'),
			join(workDir, 'top.txt'),
		])
		await sandbox.destroy()
	})

	it('hides dotfiles from a wildcard unless includeHidden is set', async () => {
		const sandbox = await build()
		writeFileSync(join(workDir, 'visible.txt'), 'v')
		writeFileSync(join(workDir, '.hidden.txt'), 'h')

		expect(await collect(sandbox, workDir, { maxEntries: 100 })).toEqual([
			join(workDir, 'visible.txt'),
		])
		expect(await collect(sandbox, workDir, { maxEntries: 100, includeHidden: true })).toEqual([
			join(workDir, '.hidden.txt'),
			join(workDir, 'visible.txt'),
		])
		await sandbox.destroy()
	})

	it('reports a root that does not exist as an empty walk rather than a failure', async () => {
		const sandbox = await build()
		expect(await collect(sandbox, join(workDir, 'never-created'), { maxEntries: 10 })).toEqual([])
		await sandbox.destroy()
	})

	it('does not follow symlinks: neither a linked file nor a linked directory', async () => {
		const sandbox = await build()
		mkdirSync(join(workDir, 'real'), { recursive: true })
		writeFileSync(join(workDir, 'real', 'target.txt'), 'target')
		symlinkSync(join(workDir, 'real', 'target.txt'), join(workDir, 'link-to-file.txt'))
		symlinkSync(join(workDir, 'real'), join(workDir, 'link-to-dir'))

		// The real file appears exactly once, under its real path. Following
		// the directory link would have reported it a second time through
		// `link-to-dir/target.txt`, and following the file link a third time.
		expect(await collect(sandbox, workDir, { maxEntries: 100 })).toEqual([
			join(workDir, 'real', 'target.txt'),
		])
		await sandbox.destroy()
	})

	it('refuses a walk root reached through a symbolic link', async () => {
		const sandbox = await build()
		mkdirSync(join(workDir, 'real'), { recursive: true })
		writeFileSync(join(workDir, 'real', 'target.txt'), 'target')
		symlinkSync(join(workDir, 'real'), join(workDir, 'link-to-dir'))

		await expect(
			collect(sandbox, join(workDir, 'link-to-dir'), { maxEntries: 10 }),
		).rejects.toThrow(/symbolic link/)
		await sandbox.destroy()
	})

	it('raises ERR_FILE_WALK_LIMIT when the examined-entry budget runs out', async () => {
		const sandbox = await build()
		mkdirSync(join(workDir, 'many'), { recursive: true })
		for (let index = 0; index < 40; index += 1) {
			writeFileSync(join(workDir, 'many', `f${index}.txt`), 'x')
		}
		// An incomplete search is an error carrying a code, never a short list
		// the caller would read as "that is all there is".
		await expect(
			collect(sandbox, workDir, { maxEntries: 100, maxVisitedEntries: 5 }),
		).rejects.toMatchObject({ code: 'ERR_FILE_WALK_LIMIT' })
		await sandbox.destroy()
	})

	it('counts as an execution: status is busy for the whole walk, not per entry', async () => {
		const sandbox = await build()
		const observed: string[] = []
		let seen = 0
		for await (const _entry of sandbox.walkFiles(bigFixture, { maxEntries: 20 })) {
			observed.push(sandbox.status)
			seen += 1
			if (seen >= 3) break
		}
		// Three consecutive yields, every one of them inside the execution.
		expect(observed).toEqual(['busy', 'busy', 'busy'])
		expect(sandbox.status).toBe('ready')
		await sandbox.destroy()
	})

	it('refuses a walk once the sandbox has been destroyed', async () => {
		const sandbox = await build()
		await sandbox.destroy()
		await expect(collect(sandbox, workDir, { maxEntries: 10 })).rejects.toThrow(/destroyed/)
	})
})

/**
 * Whether anything in this host's process table is still running the walk
 * whose plan carried `marker` (its root path) in its argv.
 *
 * Asked THROUGH the sandbox, as an ordinary `exec`, so the question is put to
 * the guest rather than to the test process — the same question a real
 * deployment's operator would put to its pod. The marker travels in the
 * environment, never in this scanner's own argv, so the scanner can never
 * count itself.
 */
const PROCESS_SCAN = [
	"const fs = require('node:fs');",
	'const marker = process.env.NAMZU_WALK_MARKER;',
	'let count = 0;',
	"for (const name of fs.readdirSync('/proc')) {",
	'  if (!/^[0-9]+$/.test(name)) continue;',
	'  let cmdline;',
	"  try { cmdline = fs.readFileSync('/proc/' + name + '/cmdline', 'utf8'); } catch { continue; }",
	'  if (cmdline.includes(marker)) count += 1;',
	'}',
	'process.stdout.write(String(count));',
].join('\n')

describe.skipIf(IS_WINDOWS || process.platform !== 'linux')('walkFiles cancellation', () => {
	const walkAll = {
		maxEntries: BIG_FIXTURE_TOTAL,
		maxVisitedEntries: BIG_FIXTURE_TOTAL * 4,
	} as const

	/**
	 * How long an UNINTERRUPTED walk of the big fixture takes on this machine.
	 *
	 * Measured, not hard-coded, and measured once for the whole describe: it is
	 * the number both cases below subtract their own stop from, so the
	 * assertion scales with whatever machine runs it instead of encoding this
	 * one's ~1.7 s.
	 */
	let naturalWalkMs: number | undefined

	const measureNaturalWalk = async (sandbox: KubernetesSandboxHandle): Promise<number> => {
		if (naturalWalkMs !== undefined) return naturalWalkMs
		const started = Date.now()
		let seen = 0
		for await (const _entry of sandbox.walkFiles(bigFixture, walkAll)) seen += 1
		expect(seen).toBe(BIG_FIXTURE_TOTAL)
		naturalWalkMs = Math.max(1, Date.now() - started)
		return naturalWalkMs
	}

	const countWalkProcesses = async (
		sandbox: KubernetesSandboxHandle,
		marker: string,
	): Promise<number> => {
		const result = await sandbox.exec('node', ['-e', PROCESS_SCAN], {
			env: { NAMZU_WALK_MARKER: marker },
		})
		expect(result.exitCode).toBe(0)
		return Number.parseInt(result.stdout.trim(), 10)
	}

	/** One scan, and what it cost — the unit the budget below is built from. */
	const timedCount = async (
		sandbox: KubernetesSandboxHandle,
		marker: string,
	): Promise<{ count: number; ms: number }> => {
		const started = Date.now()
		const count = await countWalkProcesses(sandbox, marker)
		return { count, ms: Math.max(1, Date.now() - started) }
	}

	/**
	 * The window a real cancellation has to land in, and the check that the
	 * window means anything.
	 *
	 * A backend that accepted the cancellation and did nothing cannot produce a
	 * process table without the walk in it until the walk FINISHES, which costs
	 * the rest of `naturalWalkMs`. So the budget is a third of that plus two
	 * process scans (a real stop pays for one scan, and the slack is the
	 * second), and `naturalWalkMs` has to be at least 4.5 scans for the two
	 * outcomes to be separated at all. On a machine fast enough to blur them
	 * this fails LOUDLY, naming both numbers, rather than passing because the
	 * walk had already ended.
	 */
	const cancellationBudgetMs = (probeMs: number): number => {
		const natural = naturalWalkMs ?? 0
		if (natural <= probeMs * 4.5) {
			throw new Error(
				`the fixture no longer discriminates on this machine: an uninterrupted walk of ${BIG_FIXTURE_TOTAL} files took ${natural} ms against a ${probeMs} ms process scan, so "no walk process afterwards" can no longer tell a killed walk from a finished one. Grow BIG_FIXTURE_DIRS/BIG_FIXTURE_FILES_PER_DIR.`,
			)
		}
		return probeMs * 2 + natural / 3
	}

	/** Scans until the walk is gone or the budget runs out; answers the last count. */
	const waitForNoWalkProcess = async (
		sandbox: KubernetesSandboxHandle,
		marker: string,
		budgetMs: number,
	): Promise<number> => {
		const deadline = Date.now() + budgetMs
		let last = await countWalkProcesses(sandbox, marker)
		while (last !== 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25))
			last = await countWalkProcesses(sandbox, marker)
		}
		return last
	}

	it('breaking out of the iterator after 5 entries leaves no walk process in the guest', async () => {
		const sandbox = await build()
		const natural = await measureNaturalWalk(sandbox)
		const iterator = sandbox.walkFiles(bigFixture, walkAll)[Symbol.asyncIterator]()

		const seen: string[] = []
		for (let index = 0; index < 5; index += 1) {
			const step = await iterator.next()
			expect(step.done).toBe(false)
			if (step.done !== true) seen.push(step.value.path)
		}
		expect(seen.length).toBe(5)

		// The positive control, and the reason the fixture is 12,000 files: there
		// IS a walk process to kill at the moment the consumer stops.
		const probe = await timedCount(sandbox, bigFixture)
		expect(probe.count).toBeGreaterThan(0)

		const budget = cancellationBudgetMs(probe.ms)
		const stopped = Date.now()
		await iterator.return?.(undefined)
		expect(await waitForNoWalkProcess(sandbox, bigFixture, budget)).toBe(0)
		// The negative control: gone because it was KILLED, not because the walk
		// ran out of tree. A backend that ignored `return()` would still owe most
		// of `natural` milliseconds here.
		expect(Date.now() - stopped).toBeLessThan(budget)
		expect(budget).toBeLessThan(natural)
		await sandbox.destroy()
	})

	it('aborting options.signal stops the walk and leaves no process behind', async () => {
		const sandbox = await build()
		const natural = await measureNaturalWalk(sandbox)
		const controller = new AbortController()
		const iterator = sandbox
			.walkFiles(bigFixture, { ...walkAll, signal: controller.signal })
			[Symbol.asyncIterator]()

		const first = await iterator.next()
		expect(first.done).toBe(false)
		const probe = await timedCount(sandbox, bigFixture)
		expect(probe.count).toBeGreaterThan(0)

		const budget = cancellationBudgetMs(probe.ms)
		const stopped = Date.now()
		controller.abort(new Error('the caller stopped searching'))
		// Whichever way the abort settles the iteration — a rejection or a
		// clean stop — is compliant; what is never compliant is a guest
		// process still walking afterwards, or one that only stops because the
		// tree ran out.
		await iterator.next().catch(() => undefined)
		await iterator.return?.(undefined).catch(() => undefined)
		expect(await waitForNoWalkProcess(sandbox, bigFixture, budget)).toBe(0)
		expect(Date.now() - stopped).toBeLessThan(budget)
		expect(budget).toBeLessThan(natural)
		await sandbox.destroy()
	})
})

/**
 * The acceptance the issue states in the host's own terms: with `walkFiles`
 * present, the SDK's `glob` and `grep` builtins work over a kubernetes
 * sandbox with no host-side change, and return what the LOCAL provider
 * returns for the same tree.
 *
 * Runs without a cluster — the "guest" is the real agent on loopback over the
 * same directory the local provider is pointed at — so the comparison is
 * between two enumerators over one filesystem, which is exactly the claim
 * being made.
 */
describe.skipIf(IS_WINDOWS)('the glob and grep builtins over a kubernetes sandbox', () => {
	const context = (sandbox: Sandbox | undefined, workingDirectory: string): ToolContext =>
		({ workingDirectory, sandbox, abortSignal: new AbortController().signal }) as ToolContext

	const grepArgs = (extra: object) => ({
		pattern: '^7:42$',
		case_sensitive: true,
		context_lines: 0,
		max_results: 100,
		...extra,
	})

	it(`returns what the local provider returns for a ${BIG_FIXTURE_TOTAL}-file tree`, async () => {
		const sandbox = await build(bigFixture)

		const viaSandbox = await GlobTool.execute({ pattern: 'd7/*.txt' }, context(sandbox, bigFixture))
		const viaLocal = await GlobTool.execute({ pattern: 'd7/*.txt' }, context(undefined, bigFixture))

		expect(viaSandbox.success).toBe(true)
		expect(viaLocal.success).toBe(true)
		const sandboxFiles = (viaSandbox.data as { files: string[] }).files.slice().sort()
		const localFiles = (viaLocal.data as { files: string[] }).files.slice().sort()
		expect(sandboxFiles.length).toBe(BIG_FIXTURE_FILES_PER_DIR)
		expect(sandboxFiles).toEqual(localFiles)

		const grepSandbox = await GrepTool.execute(
			grepArgs({ include: 'd7/*.txt' }),
			context(sandbox, bigFixture),
		)
		const grepLocal = await GrepTool.execute(
			grepArgs({ include: 'd7/*.txt' }),
			context(undefined, bigFixture),
		)
		expect(grepSandbox.success).toBe(true)
		expect(grepLocal.success).toBe(true)
		expect(grepSandbox.output).toContain('f42.txt:1:7:42')
		expect(grepSandbox.output.split('\n').sort()).toEqual(grepLocal.output.split('\n').sort())
		await sandbox.destroy()
	}, 60_000)

	it('no longer refuses the builtins for a missing walkFiles', async () => {
		const sandbox = await build()
		writeFileSync(join(workDir, 'seen.md'), 'content')

		const result = await GlobTool.execute({ pattern: '*.md' }, context(sandbox, workDir))
		// The refusal this issue is about, in the builtin's own words.
		expect(result.error ?? '').not.toContain('bounded file discovery')
		expect(result.success).toBe(true)
		expect((result.data as { files: string[] }).files).toEqual(['./seen.md'])
		await sandbox.destroy()
	})
})
