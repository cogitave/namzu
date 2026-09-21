import type { PathBuilder } from '../../session/workspace/path-builder.js'
import { InMemoryCheckpointStore } from '../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../store/run/memory.js'
import { InMemoryTokenBudgetStore } from '../../store/run/token-budget-memory.js'
import type { CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { RunStore } from '../../types/run/store.js'
import type { TokenBudgetStore } from '../../types/run/token-budget-store.js'

interface HeldStores {
	readonly checkpoints: CheckpointStore
	readonly tokenBudget: TokenBudgetStore
}

const held = new WeakMap<InMemoryRunStore, HeldStores>()

/**
 * The checkpoint store and token ledger a run gets when its run store is in
 * memory and the host named no place on disk.
 *
 * Without this, a host passing an {@link InMemoryRunStore} and no
 * `pathBuilder` kept its run evidence in memory while the ledger and the
 * checkpoints went to disk under `defaultStateRoot()` — a per-user directory
 * the host never chose, with no retention, one tree per run. A run store in
 * memory says the host wants the run to die with the process; the rest of the
 * run's state follows it.
 *
 * Returns `undefined` — the disk defaults apply — when the run store is not
 * an `InMemoryRunStore`, when a `pathBuilder` was given (the host naming
 * where generated state goes), or when a `checkpointStore` was given. That
 * last one is deliberate: a host that chose where checkpoints live may resume
 * from them in a fresh process, with a fresh run store, and a checkpoint binds
 * its run to the ledger by reference. Holding that ledger in a run store the
 * resume no longer has would make every such resume fail with "The token
 * budget ledger required by this run is missing". Such a host keeps the disk
 * ledger it had, or passes a `tokenBudgetStore` beside its checkpoint store.
 *
 * The stores are held per run store instance, so a host that reuses one
 * `InMemoryRunStore` across calls can resume a run from a checkpoint the
 * earlier call wrote, and two instances never see each other's state.
 */
export function storesHeldInMemory(
	runStore: RunStore | undefined,
	pathBuilder: PathBuilder | undefined,
	checkpointStore: CheckpointStore | undefined,
): HeldStores | undefined {
	if (pathBuilder !== undefined || checkpointStore !== undefined) return undefined
	if (!(runStore instanceof InMemoryRunStore)) return undefined
	let stores = held.get(runStore)
	if (!stores) {
		stores = {
			checkpoints: new InMemoryCheckpointStore(),
			tokenBudget: new InMemoryTokenBudgetStore(),
		}
		held.set(runStore, stores)
	}
	return stores
}
