// Checkpoint documents under `<session-id>/checkpoints/` and their retention.
// The public barrels re-export this module.
export {
	CheckpointIntegrityError,
	CheckpointOwnerError,
	checkpointRecordPath,
	serializeCheckpoint,
	validateCheckpointScope,
} from './contract.js'
export type {
	CheckpointLogView,
	CheckpointRefusalReason,
	CheckpointScope,
	CheckpointWriteReceipt,
	SessionCheckpointStore,
} from './contract.js'
export { DiskSessionCheckpointStore } from './disk.js'
export type { DiskSessionCheckpointStoreOptions } from './disk.js'
export { InMemorySessionCheckpointStore } from './memory.js'
export type { InMemorySessionCheckpointStoreOptions } from './memory.js'
export { selectSessionCheckpointsToPrune } from './prune.js'
export type { PrunableSessionCheckpoint } from './prune.js'
