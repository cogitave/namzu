import type { PathBuilder } from '../../session/workspace/path-builder.js'
import { InMemoryCheckpointStore } from '../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../store/run/memory.js'
import type { ChildRunStorage } from '../../types/agent/task.js'
import type { CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { RunStore } from '../../types/run/store.js'
import type { TokenBudgetStore } from '../../types/run/token-budget-store.js'

/** What a run store in memory holds for the one run it is bound to. */
interface HeldState {
	readonly runId: string
	readonly checkpoints: InMemoryCheckpointStore
}

const held = new WeakMap<InMemoryRunStore, HeldState>()

/** Where one run's checkpoints, ledger and delegated children go. */
export interface RunStorage {
	/** The run's checkpoint store; `undefined` means the disk default. */
	readonly checkpoints: CheckpointStore | undefined
	/**
	 * The run's token ledger; `undefined` means disk, beside the checkpoints,
	 * under the `pathBuilder` (or `defaultStateRoot()`).
	 */
	readonly tokenBudget: TokenBudgetStore | undefined
	/** What a delegated child of this run is told; `undefined` leaves it alone. */
	readonly children: ChildRunStorage | undefined
}

export interface RunStorageInput {
	readonly runStore: RunStore | undefined
	readonly pathBuilder: PathBuilder | undefined
	readonly checkpointStore: CheckpointStore | undefined
	readonly tokenBudgetStore?: TokenBudgetStore | undefined
	readonly runId: string
}

/**
 * The one answer to "where does this run's state live", read by every place
 * that opens a checkpoint store or a token ledger for a run: the run context,
 * the query's budget resolution and the composite agents' budget resolution.
 *
 * The rules, in order:
 *
 * - **Checkpoints.** An explicit `checkpointStore` wins. Otherwise, a run
 *   whose `runStore` is an {@link InMemoryRunStore} and which names no
 *   `pathBuilder` keeps its checkpoints in memory, in a store that run store
 *   holds for the run it is bound to. Otherwise the disk default applies.
 * - **Ledger.** An explicit `tokenBudgetStore` wins. Otherwise the ledger
 *   lives where the checkpoints live: in an {@link InMemoryCheckpointStore}'s
 *   own {@link InMemoryCheckpointStore.tokenBudgets} when the checkpoints are
 *   in one (passed explicitly or held for an in-memory run store), and on
 *   disk beside them otherwise. A checkpoint binds its run to the ledger by
 *   reference, so the two have to travel together: a resume that finds the
 *   checkpoint finds the ledger with it, and a host that copies a checkpoint
 *   store copies both.
 * - **Children.** A run whose run store is in memory and which names no
 *   `pathBuilder` hands that choice to its delegated children, so a child
 *   does not fall back to a disk tree under `defaultStateRoot()` its parent
 *   never asked for.
 *
 * **Scoped to one run.** What an in-memory run store holds is released when
 * the same store is used for a different run id, which is when
 * {@link InMemoryRunStore.initRun} drops the previous run's evidence too. A
 * long-lived host that reuses one `InMemoryRunStore` therefore holds one
 * run's checkpoints and ledger, not one per run it ever started, while a
 * resume of the current run (same run id) in the same process still finds
 * them. Within the run, `runConfig.pruneKeepLast` bounds the checkpoints
 * exactly as it does on disk.
 */
export function resolveRunStorage(input: RunStorageInput): RunStorage {
	const inMemory = input.runStore instanceof InMemoryRunStore && input.pathBuilder === undefined
	const checkpoints =
		input.checkpointStore ??
		(inMemory ? heldCheckpoints(input.runStore as InMemoryRunStore, input.runId) : undefined)
	const tokenBudget =
		input.tokenBudgetStore ??
		(checkpoints instanceof InMemoryCheckpointStore ? checkpoints.tokenBudgets : undefined)
	const children: ChildRunStorage | undefined = inMemory
		? {
				kind: 'memory',
				...(input.checkpointStore ? { checkpointStore: input.checkpointStore } : {}),
			}
		: undefined
	return { checkpoints, tokenBudget, children }
}

function heldCheckpoints(runStore: InMemoryRunStore, runId: string): InMemoryCheckpointStore {
	const current = held.get(runStore)
	if (current?.runId === runId) return current.checkpoints
	// A different run: the previous one's checkpoints and ledger go with the
	// reference, the same way `initRun` forgets the previous run's evidence.
	const next: HeldState = { runId, checkpoints: new InMemoryCheckpointStore() }
	held.set(runStore, next)
	return next.checkpoints
}

/**
 * @internal What `runStore` holds right now, for tests that assert it holds
 * one run's state and no more.
 */
export function heldRunState(runStore: InMemoryRunStore): HeldState | undefined {
	return held.get(runStore)
}
