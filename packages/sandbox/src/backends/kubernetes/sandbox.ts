/**
 * The {@link Sandbox} a kubernetes acquire hands back: the SDK contract,
 * served over the guest agent's TCP transport, with the lease that keeps the
 * cluster from deleting the pod out from under a long run.
 *
 * Split out of `index.ts` because that file is about the CONTROL plane —
 * claim, poll, address, release — and this one is about the DATA plane, and
 * the two are read for different reasons.
 *
 * ## What it implements, and what it deliberately does not
 *
 * Implemented: `exec` (through the shared {@link RemoteExecutionController},
 * so an `AbortSignal` terminates the guest process rather than abandoning
 * the wait), `writeFile`, `readFile`, `listFiles`, `walkFiles`,
 * `openTerminal`, `openTcpConnection`, `destroy`.
 *
 * Absent on purpose, because the SDK's contract says a backend that cannot
 * honour an optional method must omit it rather than accept and ignore:
 *
 *  - `setNetworkPolicy` — egress here is a `NetworkPolicy` attached to the
 *    pool's `SandboxTemplate`. There is no per-running-pod knob to turn, and
 *    a policy accepted and not applied is worse than one never offered: the
 *    caller stops looking.
 *  - `spawnDetached` — the guest agent has no op that starts a process and
 *    returns it running. A host asking for background jobs must be told no.
 *
 * ## Terminals are owned
 *
 * `openTerminal` is only a compliant implementation if `destroy()` kills and
 * awaits every terminal it returned, so open terminals are tracked and
 * reaped before the object is released — the same thing the Firecracker
 * backend does, for the same contract.
 *
 * ## Two terminal states, one `SandboxStatus`
 *
 * `SandboxStatus` has exactly four members and this change does not widen
 * the SDK's union, so both ways a sandbox ends report `'destroyed'`. They
 * are told apart by the error a later call throws:
 * {@link KubernetesSandboxDestroyedError} (this host released it) and
 * {@link KubernetesSandboxGoneError} (the cluster deleted it — the lease
 * renewal found the object already gone).
 */

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
	SandboxTcpConnectOptions,
	SandboxTcpConnection,
	SandboxWalkFilesOptions,
	TerminalSession,
} from '@namzu/sdk'
import { walkFilesViaExec } from '@namzu/sdk'

import { OperationDeadline } from '../readiness.js'
import {
	RemoteCancellationUnknownError,
	type SandboxRetirementObservation,
} from '../remote-execution-controller.js'
import { KubernetesLeaseRenewal } from './lease.js'
import type { KubernetesAgentTransport } from './transport.js'

/**
 * How long a retirement triggered by an unconfirmed cancellation may spend
 * deleting the object. Separate from every other clock on the path: the
 * caller's own deadline has usually already expired by the time this runs,
 * and reusing it would mean skipping teardown exactly when a command of
 * unknown state is still out there.
 */
const RETIREMENT_TIMEOUT_MS = 15_000

/** Thrown by any operation on a sandbox this host already destroyed. */
export class KubernetesSandboxDestroyedError extends Error {
	override readonly name = 'KubernetesSandboxDestroyedError'

	constructor(
		readonly operation: string,
		readonly sandboxName: string,
	) {
		super(
			`kubernetes sandbox ${sandboxName} has been destroyed; ${operation}() cannot be admitted. Acquire a new sandbox — a destroyed one's pod, Service and claim are deleted and its agent address no longer resolves.`,
		)
	}
}

/**
 * Thrown by any operation on a sandbox the CLUSTER removed while this
 * handle still held it — the lease renewal PATCH came back 404/410. Distinct
 * from {@link KubernetesSandboxDestroyedError} because nothing this host did
 * caused it: the object expired, an operator deleted it, or the controller
 * reaped it, and the actionable advice is different.
 */
export class KubernetesSandboxGoneError extends Error {
	override readonly name = 'KubernetesSandboxGoneError'

	constructor(
		readonly operation: string,
		readonly sandboxName: string,
	) {
		super(
			`kubernetes sandbox ${sandboxName} no longer exists on the cluster; ${operation}() cannot be admitted. Its lease renewal found the object already deleted — it expired (spec.lifecycle.shutdownTime), an operator deleted it, or the controller reaped it. Nothing this handle can do brings it back; acquire a new sandbox.`,
		)
	}
}

interface KubernetesSandboxBaseOptions {
	/** The cluster's own name for the bound sandbox — also the sandbox id. */
	readonly name: string
	readonly rootDir: string
	readonly transport: KubernetesAgentTransport
	/** DELETE the object this backend created. Already-gone counts as done. */
	readonly release: (signal?: AbortSignal) => Promise<void>
	/**
	 * Decide what an execution whose cancellation could not be CONFIRMED
	 * does to this sandbox — called instead of retiring it, and answering
	 * the {@link SandboxRetirementObservation} that goes onto the error the
	 * caller is about to receive.
	 *
	 * Unset (the task path, and the Firecracker tier through its own
	 * transport) keeps the shared controller's rule verbatim: a command of
	 * unknown state is still in that pod, the pod stops being reusable, and
	 * the handle retires it through {@link release}. That is right for a
	 * disposable object whose disk is scratch.
	 *
	 * It is wrong for an object that is not disposable. On a workspace
	 * `release` is an `operatingMode: Suspended` patch, which makes the
	 * controller delete the pod — so eight seconds of network loss under one
	 * `exec()` would take every other holder's terminals, dev servers and
	 * running commands with it, and no host-side lock can prevent it because
	 * no caller issued it. The workspace passes a hook that keeps the pod,
	 * diagnoses the agent and says `accepted: false` with a `reason` rather
	 * than letting a decision that large be made from inside a failing call.
	 *
	 * It must not reject; one that does is reported as an unaccepted
	 * retirement carrying its own error, so a broken hook cannot replace the
	 * error the caller asked about.
	 */
	readonly onUnconfirmedCancellation?: (
		error: RemoteCancellationUnknownError,
	) => Promise<SandboxRetirementObservation>
}

/**
 * The lease half of the options: a way to move the expiry, and the expiry it
 * is moving. Required TOGETHER, because `renew` without `ttlSeconds` is a
 * renewal loop with nothing to stamp — it would re-stamp `now + 0`, an
 * expiry already in the past, and hand the object straight to the
 * controller's reaper while reporting every tick a success. A pair is the
 * only shape that cannot be half-configured.
 */
interface KubernetesSandboxLeaseOptions {
	/** PATCH the object's `shutdownTime` forward. See `lease.ts`. */
	readonly renew: (shutdownTime: string, signal?: AbortSignal) => Promise<void>
	/** The TTL acquire stamped; each renewal re-stamps exactly this much. */
	readonly ttlSeconds: number
	readonly onRenewalError?: (error: unknown) => void
	/** Test seam: the renewal loop's base interval. Default: half the TTL. */
	readonly leaseIntervalMs?: number
}

/**
 * The other arm: an object that carries no expiry, so this handle runs no
 * renewal loop at all — the persistent workspace (`workspace.ts`), which is
 * explicitly managed and must outlive a host that stopped renewing. A no-op
 * `renew` would be the wrong way to say that: it would leave a timer ticking
 * forever to do nothing. The lease fields are typed `undefined` rather than
 * omitted so that passing one of them here is a type error and not an
 * excess-property check a spread would slip past.
 */
interface KubernetesSandboxUnleasedOptions {
	readonly renew?: undefined
	readonly ttlSeconds?: undefined
	readonly onRenewalError?: undefined
	readonly leaseIntervalMs?: undefined
}

export type KubernetesSandboxOptions = KubernetesSandboxBaseOptions &
	(KubernetesSandboxLeaseOptions | KubernetesSandboxUnleasedOptions)

function detectEnvironment(): SandboxEnvironment {
	// The guest runs Linux; the enum describes the host-facing shape of the
	// worker, not the isolation technology under it. Firecracker's guest
	// reports the same for the same reason.
	return 'linux-namespace'
}

/**
 * What this backend hands back: the SDK contract, with the two optional
 * members it DOES implement narrowed to present, so a caller that composes
 * one — `workspace.ts` wraps this handle — does not have to re-check for a
 * method this file always defines.
 */
export type KubernetesSandboxHandle = Sandbox &
	Required<Pick<Sandbox, 'openTerminal' | 'openTcpConnection' | 'walkFiles'>>

/**
 * Build the handle. It does NOT run the acquire-time privilege probe — that
 * is `create()`'s job in `index.ts`, so that a refusal can destroy this
 * object before any caller has a reference to it, and so this function stays
 * usable by the workspace path that runs its own probe.
 */
export function buildKubernetesSandbox(options: KubernetesSandboxOptions): KubernetesSandboxHandle {
	// The cluster owns this name. Preserving it verbatim as the sandbox id —
	// as the Firecracker backend preserves its orchestrator's — means a log
	// line carrying an id is also a `kubectl get sandbox` argument.
	const id = options.name as SandboxId
	const transport = options.transport

	type Lifecycle = 'active' | 'retiring' | 'destroyed' | 'gone'
	let lifecycle: Lifecycle = 'active'
	let activeExecutions = 0
	let teardownPromise: Promise<void> | undefined
	let teardownComplete = false
	let retirementPromise: Promise<SandboxRetirementObservation> | undefined
	const terminals = new Set<TerminalSession>()

	// No `renew` ⇒ no expiry to move ⇒ no loop. `stop()` on the undefined
	// case is the caller's problem to not have, which is why every use below
	// goes through `lease?.stop()`.
	const renew = options.renew
	const ttlSeconds = options.ttlSeconds
	// The type above already pairs the two. This is the runtime half of the
	// same rule, for a caller that reached here through a cast or from
	// JavaScript: a lease stamping `now + 0` expires the moment it is written,
	// and every tick would report success while the controller deleted the
	// object underneath it.
	if (renew !== undefined && (typeof ttlSeconds !== 'number' || ttlSeconds <= 0)) {
		throw new Error(
			`kubernetes: sandbox ${options.name} was given a lease renewal with ttlSeconds ${String(ttlSeconds)}. A renewal re-stamps shutdownTime as now + ttlSeconds, so a zero or absent TTL stamps an expiry that has already passed and the object is reaped while the loop reports every tick a success. Pass renew and a positive ttlSeconds together, or neither — an object with no expiry (a persistent workspace) runs no renewal loop.`,
		)
	}
	// `ttlSeconds === undefined` is unreachable once `renew` is defined — the
	// throw above saw to that — and is written out anyway because it is what
	// narrows the field to a number for the constructor below.
	const lease =
		renew === undefined || ttlSeconds === undefined
			? undefined
			: new KubernetesLeaseRenewal({
					ttlSeconds,
					renew,
					onGone: () => {
						// The object is gone; the pod behind the address went with it.
						// Refuse every later call by name rather than let it dial into a
						// connect timeout with nothing to explain it.
						if (lifecycle === 'active') lifecycle = 'gone'
					},
					...(options.onRenewalError !== undefined
						? { onRenewalError: options.onRenewalError }
						: {}),
					...(options.leaseIntervalMs !== undefined ? { intervalMs: options.leaseIntervalMs } : {}),
				})
	lease?.start()

	const assertAdmissible = (operation: string): void => {
		if (lifecycle === 'active') return
		if (lifecycle === 'gone') throw new KubernetesSandboxGoneError(operation, options.name)
		throw new KubernetesSandboxDestroyedError(operation, options.name)
	}

	const teardown = (signal?: AbortSignal): Promise<void> => {
		if (lifecycle === 'active') lifecycle = 'retiring'
		lease?.stop()
		if (teardownComplete) return Promise.resolve()
		if (teardownPromise) return teardownPromise
		const shared = options.release(signal).then(
			() => {
				teardownComplete = true
				lifecycle = 'destroyed'
			},
			(error: unknown) => {
				// A failed teardown must stay retryable; keeping the rejected
				// promise would answer every later destroy() with the same
				// stale failure.
				if (teardownPromise === shared) teardownPromise = undefined
				throw error
			},
		)
		teardownPromise = shared
		return shared
	}

	/**
	 * A command whose cancellation the guest could not confirm may still be
	 * running in that pod, so the pod stops being reusable. Retire it and
	 * report whether the retirement landed, on the error the caller is about
	 * to receive.
	 */
	const retire = (): Promise<SandboxRetirementObservation> => {
		if (lifecycle === 'active') lifecycle = 'retiring'
		retirementPromise ??= new OperationDeadline(
			RETIREMENT_TIMEOUT_MS,
			`kubernetes sandbox ${options.name} retirement`,
		)
			.run(async (signal) => await teardown(signal))
			.then(() => ({ accepted: true as const }))
			.catch((error: unknown) => ({
				accepted: false as const,
				error: error instanceof Error ? error : new Error(String(error)),
			}))
		return retirementPromise
	}

	/**
	 * What an unconfirmed cancellation does to THIS sandbox: retire it, or
	 * whatever the owner's hook decided instead — see
	 * {@link KubernetesSandboxBaseOptions.onUnconfirmedCancellation}.
	 */
	const observeUnconfirmedCancellation = async (
		error: RemoteCancellationUnknownError,
	): Promise<SandboxRetirementObservation> => {
		const decide = options.onUnconfirmedCancellation
		if (decide === undefined) return await retire()
		try {
			return await decide(error)
		} catch (hookError: unknown) {
			// The caller is already receiving `error`; a hook that threw must
			// not replace it, and must not be reported as a teardown that was
			// attempted either.
			return {
				accepted: false,
				error: hookError instanceof Error ? hookError : new Error(String(hookError)),
			}
		}
	}

	const runExecution = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
		assertAdmissible(operation)
		activeExecutions += 1
		try {
			return await run()
		} catch (error) {
			if (error instanceof RemoteCancellationUnknownError) {
				error.retirement = await observeUnconfirmedCancellation(error)
			}
			throw error
		} finally {
			activeExecutions = Math.max(0, activeExecutions - 1)
		}
	}

	return {
		id,
		get status(): SandboxStatus {
			// Four members, and no new one: a cluster-side disappearance and a
			// host-side destroy both read as 'destroyed' here and are told
			// apart by the error a later call throws.
			if (lifecycle !== 'active') return 'destroyed'
			return activeExecutions > 0 ? 'busy' : 'ready'
		},
		rootDir: options.rootDir,
		environment: detectEnvironment(),

		async exec(
			command: string,
			argv?: string[],
			opts?: SandboxExecOptions,
		): Promise<SandboxExecResult> {
			return await runExecution('exec', async () => await transport.exec(command, argv, opts))
		},

		/**
		 * Every `tcp` request dials a fresh connection, so its envelope is
		 * also that connection's first, not-yet-authenticated frame and is
		 * bounded by the guest's pre-auth frame ceiling (8 MiB by default).
		 * A body above it is no longer a refusal: the transport splits it
		 * into parts that each fit, writes them to a temporary sibling of
		 * the target and finishes with an atomic rename, so this method
		 * takes a body of any size the transport's `maxWriteFileBytes`
		 * admits (1 GiB by default). The named refusals that remain are
		 * passed through unwrapped so a caller can catch them BY CLASS:
		 * `AgentWriteFileTooLargeError` for a body above that bound, and
		 * `AgentPreauthFrameTooLargeError` for an oversized body against a
		 * guest too old to advertise the part protocol.
		 */
		async writeFile(path: string, content: string | Buffer): Promise<void> {
			assertAdmissible('writeFile')
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
			await transport.writeFile(path, buf)
		},

		async readFile(path: string): Promise<Buffer> {
			assertAdmissible('readFile')
			return await transport.readFile(path)
		},

		async openTerminal(terminalOptions: OpenTerminalOptions): Promise<TerminalSession> {
			assertAdmissible('openTerminal')
			const terminal = await transport.openTerminal(terminalOptions)
			terminals.add(terminal)
			void terminal.exited.finally(() => terminals.delete(terminal))
			return terminal
		},

		async openTcpConnection(
			connectOptions: SandboxTcpConnectOptions,
		): Promise<SandboxTcpConnection> {
			assertAdmissible('openTcpConnection')
			return await transport.openTcpConnection(connectOptions)
		},

		async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
			return await runExecution('listFiles', async () => {
				// Same wire as docker/aci/firecracker: `find -printf '%p\t%s\n'`,
				// parsed line by line, with a non-zero exit (a root that does
				// not exist yet) mapped to "empty" as the SDK contract asks.
				const result = await transport.exec('find', [rootPath, '-type', 'f', '-printf', '%p\t%s\n'])
				if (result.exitCode !== 0) return []
				const entries: SandboxFileEntry[] = []
				for (const rawLine of result.stdout.split('\n')) {
					if (!rawLine) continue
					const tab = rawLine.indexOf('\t')
					if (tab < 0) continue
					const filePath = rawLine.slice(0, tab)
					const size = Number.parseInt(rawLine.slice(tab + 1), 10)
					if (!filePath || !Number.isFinite(size)) continue
					entries.push({ path: filePath, size })
				}
				return entries
			})
		},

		/**
		 * Bounded, lazy file discovery — the method the SDK's `glob` and
		 * `grep` builtins refuse a sandbox for not having.
		 *
		 * Built on {@link walkFilesViaExec}, the same host-side enumerator the
		 * Firecracker and docker backends use, over this transport's `exec`:
		 * the guest needs no new agent op, because the walk IS an execution —
		 * `node -e` running the SDK's own walk program and streaming one JSONL
		 * record per match. The guest image is `node:22-bookworm-slim` (see
		 * `k8s/Dockerfile`) and the agent is itself node, so node on the
		 * guest's PATH is a precondition of the agent existing rather than a
		 * new requirement this method introduces.
		 *
		 * Ownership is the same as `exec`'s, and deliberately NOT
		 * `runExecution`'s: that helper wraps one awaited call, and a walk is a
		 * sequence of them. `activeExecutions` is therefore held for the whole
		 * walk rather than per entry — `status` reads `busy` from the first
		 * `next()` to the last, never flapping between yields — and an
		 * unconfirmed cancellation retires this handle exactly as a failed
		 * `exec` cancel does, on the same error class and through the same
		 * `retire()`.
		 *
		 * Cancellation: `options.signal` and the consumer's own
		 * `iterator.return()` both abort the underlying `exec`, which sends
		 * the guest a `cancel-execution` and kills the walk's process group —
		 * so breaking out of the loop after five entries leaves nothing
		 * running in the pod.
		 */
		async *walkFiles(
			rootPath: string,
			walkOptions: SandboxWalkFilesOptions,
		): AsyncIterable<SandboxFileEntry> {
			assertAdmissible('walkFiles')
			activeExecutions += 1
			try {
				yield* walkFilesViaExec(
					async (command, argv, execOpts) => await transport.exec(command, argv, execOpts),
					rootPath,
					walkOptions,
				)
			} catch (error) {
				// The same rule `runExecution` applies, inlined because a
				// generator cannot be wrapped by it: a command whose
				// cancellation the guest could not confirm may still be running
				// in that pod, so the pod stops being reusable.
				//
				// TWO SITES, ONE RULE. This block and `runExecution`'s must
				// change together — #480, which owns the unconfirmed-cancel
				// rule for this backend, is the next change to both, and a
				// change that lands in one of them is a bug in the other.
				if (error instanceof RemoteCancellationUnknownError) {
					error.retirement = await retire()
				}
				throw error
			} finally {
				activeExecutions = Math.max(0, activeExecutions - 1)
			}
		},

		async destroy(destroyOptions?: SandboxDestroyOptions): Promise<void> {
			if (retirementPromise) {
				const observation = await retirementPromise
				if (observation.accepted) return
				retirementPromise = undefined
			}
			// A terminal owns an interactive process tree in this pod. Stop and
			// await every one before releasing the object, so the SDK's
			// ownership contract is real rather than best-effort bookkeeping.
			lifecycle = lifecycle === 'active' ? 'retiring' : lifecycle
			lease?.stop()
			const activeTerminals = [...terminals]
			for (const terminal of activeTerminals) terminal.kill('SIGKILL')
			await Promise.allSettled(activeTerminals.map((terminal) => terminal.exited))
			terminals.clear()
			// Deleting the claim cascades to the sandbox it adopted through the
			// ownerReferences the controller re-parents on bind, so one DELETE
			// retires the pod, the Service and the object. An object that is
			// already gone counts as released — that is the state DELETE was
			// asking for.
			await teardown(destroyOptions?.signal)
		},
	}
}
