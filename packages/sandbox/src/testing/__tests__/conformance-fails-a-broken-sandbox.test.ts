/**
 * A conformance suite that no wrong `Sandbox` fails is decoration.
 *
 * `backends/kubernetes/__tests__/conformance.test.ts` and
 * `backends/firecracker/__tests__/conformance.test.ts` run the suite
 * against the two backends that SHIP, and both pass — which establishes
 * that the suite is satisfiable and nothing else. The question those files
 * cannot answer is the one that matters to a future backend author: would
 * this have caught me?
 *
 * So this file breaks a `Sandbox` on purpose, three ways named directly in
 * the plan this suite was written against: it resolves `exec` after abort
 * as though nothing happened, its `destroy()` leaves a terminal running,
 * and its `readFile` hands back corrupted bytes. Each must fail the suite
 * by name. The mechanism is the reason the suite takes its runner as an
 * argument: a recording `describe`/`it` turns the whole contract into
 * ordinary async functions this file can call and catch, so a case FAILING
 * is an observation here rather than a red run.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
	OpenTerminalOptions,
	Sandbox,
	SandboxDestroyOptions,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxId,
	SandboxStatus,
	SandboxWalkFilesOptions,
	TerminalSession,
} from '@namzu/sdk'
import { walkFilesViaExec } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	type ConformanceDescribe,
	type ConformanceIt,
	type MakeSandbox,
	defineSandboxConformance,
} from '../sandbox-conformance.js'

const IS_WINDOWS = process.platform === 'win32'

/** Kill a detached child's whole process group, falling back to the child alone. */
function killTree(child: ChildProcessWithoutNullStreams): void {
	if (child.pid !== undefined && process.platform !== 'win32') {
		try {
			process.kill(-child.pid, 'SIGKILL')
			return
		} catch {
			// The group leader already exited; fall through to the direct kill.
		}
	}
	child.kill('SIGKILL')
}

/**
 * A minimal but honest local `Sandbox`: real child processes for `exec`
 * (so the abort case's shell script behaves exactly as it does against a
 * real guest agent), real files under a temp root, and a synthetic
 * in-memory terminal (no real PTY needed — the suite tests OWNERSHIP, not
 * `isatty`).
 *
 * `reapTerminals` is the one seam a subclass overrides to break terminal
 * ownership without touching anything else; the other two defects override
 * `exec` and `readFile` directly.
 */
class ReferenceFakeSandbox implements Sandbox {
	readonly id = `fake-${randomUUID()}` as SandboxId
	readonly environment: SandboxEnvironment = 'basic'
	private destroyed = false
	private inFlight = 0
	protected readonly terminals = new Set<{
		proc: ChildProcessWithoutNullStreams
		exited: Promise<{ exitCode: number; signal?: number }>
	}>()

	constructor(readonly rootDir: string) {}

	get status(): SandboxStatus {
		if (this.destroyed) return 'destroyed'
		return this.inFlight > 0 ? 'busy' : 'ready'
	}

	private resolvePath(path: string): string {
		return join(this.rootDir, path)
	}

	private assertAdmissible(): void {
		if (this.destroyed) throw new Error('reference fake sandbox: destroyed')
	}

	async exec(
		command: string,
		args: string[] = [],
		opts: SandboxExecOptions = {},
	): Promise<SandboxExecResult> {
		this.assertAdmissible()
		this.inFlight += 1
		const start = performance.now()
		try {
			return await new Promise<SandboxExecResult>((resolve, reject) => {
				const child = spawn(command, args, {
					cwd: opts.cwd ?? this.rootDir,
					env: { ...process.env, ...opts.env },
					// A process-group leader, so an abort can kill the whole tree
					// a shell command spawns (e.g. a backgrounded `&` job) and not
					// just the top-level shell — the same reason the real guest
					// agent spawns detached and signals the negative pid.
					detached: process.platform !== 'win32',
				})
				let stdout = ''
				let stderr = ''
				let killedByAbort = false
				let timedOut = false

				const onAbort = () => {
					killedByAbort = true
					killTree(child)
				}
				opts.signal?.addEventListener('abort', onAbort, { once: true })
				// `SandboxExecOptions.timeout` is part of the contract this
				// class is the honest reference for, and `timedOut` is a
				// REQUIRED field on every result: a reference that always
				// reported `false` would fail the suite's own timeout case and
				// tell a backend author the wrong thing about what compliance
				// costs. The whole process group goes, for the same reason the
				// abort path kills it rather than the leader alone.
				const deadline =
					opts.timeout === undefined
						? undefined
						: setTimeout(() => {
								timedOut = true
								killTree(child)
							}, opts.timeout)

				child.stdout.on('data', (chunk: Buffer) => {
					const data = chunk.toString('utf8')
					stdout += data
					opts.onOutput?.({ stream: 'stdout', data })
				})
				child.stderr.on('data', (chunk: Buffer) => {
					const data = chunk.toString('utf8')
					stderr += data
					opts.onOutput?.({ stream: 'stderr', data })
				})
				child.once('error', reject)
				child.once('close', (code, signal) => {
					opts.signal?.removeEventListener('abort', onAbort)
					if (deadline) clearTimeout(deadline)
					resolve({
						exitCode: killedByAbort || timedOut ? -1 : (code ?? -1),
						stdout,
						stderr,
						...(signal ? { signal } : {}),
						timedOut,
						durationMs: performance.now() - start,
					})
				})
			})
		} finally {
			this.inFlight = Math.max(0, this.inFlight - 1)
		}
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		this.assertAdmissible()
		const target = this.resolvePath(path)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, content)
	}

	async readFile(path: string): Promise<Buffer> {
		this.assertAdmissible()
		return await readFile(this.resolvePath(path))
	}

	async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
		this.assertAdmissible()
		const entries: SandboxFileEntry[] = []
		const { readdir, stat } = await import('node:fs/promises')
		const walk = async (dir: string): Promise<void> => {
			let names: string[]
			try {
				names = await readdir(dir)
			} catch {
				return
			}
			for (const name of names) {
				const full = join(dir, name)
				const info = await stat(full)
				if (info.isDirectory()) await walk(full)
				else if (info.isFile()) entries.push({ path: full, size: info.size })
			}
		}
		await walk(rootPath)
		return entries
	}

	/**
	 * The same enumerator the Firecracker, docker and kubernetes backends use,
	 * over this class's own `exec` — so the suite's `walkFiles` section runs
	 * against the reference rather than passing vacuously, which is what makes
	 * a defect in it detectable here at all.
	 */
	async *walkFiles(
		rootPath: string,
		options: SandboxWalkFilesOptions,
	): AsyncIterable<SandboxFileEntry> {
		this.assertAdmissible()
		this.inFlight += 1
		try {
			yield* walkFilesViaExec(
				async (command, args, opts) => await this.exec(command, args ?? [], opts ?? {}),
				rootPath,
				options,
			)
		} finally {
			this.inFlight = Math.max(0, this.inFlight - 1)
		}
	}

	async openTerminal(options: OpenTerminalOptions): Promise<TerminalSession> {
		this.assertAdmissible()
		const child = spawn(options.command ?? '/bin/sh', options.args ?? [], {
			cwd: options.cwd ?? this.rootDir,
			env: { ...process.env, ...options.env },
			detached: process.platform !== 'win32',
		})
		const listeners = new Set<(chunk: string) => void>()
		child.stdout.on('data', (chunk: Buffer) => {
			for (const l of listeners) l(chunk.toString('utf8'))
		})
		const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
			child.once('close', (code) => resolve({ exitCode: code ?? -1 }))
		})
		const session: TerminalSession = {
			write: (data) => {
				child.stdin.write(data)
			},
			resize: () => {},
			onData: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			exited,
			kill: (signal) => {
				if (signal === undefined) killTree(child)
				else child.kill(signal as NodeJS.Signals)
			},
		}
		this.terminals.add({ proc: child, exited })
		return session
	}

	/** Kill and await every open terminal. The honest implementation; overridden by the broken variant below. */
	protected async reapTerminals(): Promise<void> {
		const active = [...this.terminals]
		for (const t of active) killTree(t.proc)
		await Promise.allSettled(active.map((t) => t.exited))
		this.terminals.clear()
	}

	async destroy(_options?: SandboxDestroyOptions): Promise<void> {
		if (this.destroyed) return
		this.destroyed = true
		await this.reapTerminals()
	}
}

/** Defect 1: ignores the `AbortSignal` entirely and lets the command run to completion. */
class ResolvesAfterAbortSandbox extends ReferenceFakeSandbox {
	override async exec(
		command: string,
		args: string[] = [],
		opts: SandboxExecOptions = {},
	): Promise<SandboxExecResult> {
		// Drop the signal before delegating — the one-line version of "does
		// not honour cancellation" a first implementation ships by omission,
		// not by malice.
		const { signal: _dropped, ...rest } = opts
		return await super.exec(command, args, rest)
	}
}

/** Defect 2: `destroy()` never reaps the terminals it owns. */
class LeaksTerminalOnDestroySandbox extends ReferenceFakeSandbox {
	protected override async reapTerminals(): Promise<void> {
		// Left running on purpose.
	}
}

/** Defect 3: hands back bytes that do not match what was written. */
class CorruptsReadFileSandbox extends ReferenceFakeSandbox {
	override async readFile(path: string): Promise<Buffer> {
		const real = await super.readFile(path)
		if (real.length === 0) return real
		const corrupted = Buffer.from(real)
		corrupted[0] = (corrupted[0] ?? 0) ^ 0xff
		return corrupted
	}
}

/** Defect 4: admits one command at a time, queueing every other one behind it. */
class SerialisesExecSandbox extends ReferenceFakeSandbox {
	private queue: Promise<unknown> = Promise.resolve()

	override async exec(
		command: string,
		args: string[] = [],
		opts: SandboxExecOptions = {},
	): Promise<SandboxExecResult> {
		// The shape a backend ships when one connection carries every
		// execution: nothing is dropped, every single result is correct, and
		// two commands are simply never in the guest at the same time.
		const mine = this.queue.then(async () => await super.exec(command, args, opts))
		this.queue = mine.catch(() => undefined)
		return await mine
	}
}

/** One registered case and what it did when run. */
interface Outcome {
	readonly name: string
	readonly failure?: string
}

/**
 * Run the whole contract against `build` and report per case.
 *
 * `expect` is vitest's real one — an assertion still throws, and the throw
 * is what this catches. Only `describe`/`it` are replaced, and `makeSandbox`
 * hands back a fresh temp-rooted instance of whatever class `build` names.
 */
async function runConformance(build: (rootDir: string) => Sandbox): Promise<Outcome[]> {
	const cases: { name: string; body: () => Promise<void> }[] = []
	const path: string[] = []
	const record: ConformanceDescribe = (name, body) => {
		path.push(name)
		body()
		path.pop()
	}
	const collect: ConformanceIt = (name, body) => {
		cases.push({ name: [...path.slice(1), name].join(' > '), body })
	}

	const roots: string[] = []
	const makeSandbox: MakeSandbox = async () => {
		const root = await mkdtemp(join(tmpdir(), 'fake-sandbox-conformance-'))
		roots.push(root)
		return { sandbox: build(root) }
	}

	defineSandboxConformance({ describe: record, it: collect, expect, makeSandbox })

	const outcomes: Outcome[] = []
	for (const one of cases) {
		try {
			await one.body()
			outcomes.push({ name: one.name })
		} catch (error) {
			outcomes.push({
				name: one.name,
				failure: error instanceof Error ? error.message : String(error),
			})
		}
	}
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
	return outcomes
}

function failed(outcomes: readonly Outcome[]): string[] {
	return outcomes.filter((o) => o.failure !== undefined).map((o) => o.name)
}

describe.skipIf(IS_WINDOWS)('the sandbox conformance suite', () => {
	it('passes a correct implementation', async () => {
		// The control, and not a formality. Every case below reads a FAILURE
		// as evidence that the suite caught the named defect; a harness that
		// mis-registers cases or mis-wires the sandbox would fail every
		// variant below for the wrong reason, including the honest one.
		const outcomes = await runConformance((root) => new ReferenceFakeSandbox(root))
		expect(failed(outcomes)).toEqual([])
		// And it registered a real contract, not an empty shell: a
		// `defineSandboxConformance` that silently registered nothing would
		// also report zero failures.
		expect(outcomes.length).toBeGreaterThan(8)
	})

	it('fails a sandbox that resolves exec after abort instead of terminating it', async () => {
		const outcomes = await runConformance((root) => new ResolvesAfterAbortSandbox(root))
		const names = failed(outcomes)

		expect(names).toContain(
			'exec > honours an AbortSignal: the process is really terminated, never a partial success',
		)
		// Everything else about this sandbox is honest — the failure should
		// name the abort case and nothing that has nothing to do with it.
		expect(names).not.toContain('file IO > round-trips a UTF-8 string through writeFile/readFile')
	})

	it('fails a sandbox whose destroy() leaves a terminal running', async () => {
		const outcomes = await runConformance((root) => new LeaksTerminalOnDestroySandbox(root))
		const names = failed(outcomes)

		expect(names).toContain(
			'openTerminal > is owned by the sandbox: destroy() kills and awaits every terminal it returned',
		)
		expect(names).not.toContain(
			'exec > honours an AbortSignal: the process is really terminated, never a partial success',
		)
	})

	it('fails a sandbox that runs one command at a time behind a queue', async () => {
		const outcomes = await runConformance((root) => new SerialisesExecSandbox(root))
		const names = failed(outcomes)

		expect(names).toContain(
			'concurrent exec > runs several commands at once on one sandbox, with no cross-talk between their results',
		)
		// Everything about a single command is honest on this sandbox, which is
		// the point: the concurrency case is the only one that can catch it,
		// and it does — on the `busy` read, because a command sitting in a
		// queue is not in flight. A backend that reported `busy` anyway would
		// go on to fail the marks, whose whole design is that a command run on
		// its own can only ever see its own.
		expect(names).not.toContain('file IO > round-trips a UTF-8 string through writeFile/readFile')
		expect(names).not.toContain(
			'exec > honours an AbortSignal: the process is really terminated, never a partial success',
		)
	})

	it('fails a sandbox whose readFile returns corrupted bytes', async () => {
		const outcomes = await runConformance((root) => new CorruptsReadFileSandbox(root))
		const names = failed(outcomes)

		expect(names).toContain('file IO > round-trips a UTF-8 string through writeFile/readFile')
		expect(names).toContain('file IO > round-trips arbitrary binary content byte for byte')
		expect(names).not.toContain(
			'openTerminal > is owned by the sandbox: destroy() kills and awaits every terminal it returned',
		)
	})
})
