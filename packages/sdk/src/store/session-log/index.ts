// The session log: one append-only, hash-chained JSONL file per session
// (`DiskSessionLog`, `InMemorySessionLog`, the chain, the fold, the lease).
// The public barrels re-export this module. The conformance suite
// (`conformance.ts`) is deliberately not re-exported here: like the other
// suites it belongs on the `@namzu/sdk/testing` subpath, so importing it is a
// deliberate act and the root entry stays free of anything shaped like a test.

export {
	type LogBytes,
	LineSplitter,
	SessionLogChain,
	type ChainStart,
	type SessionLogBreakReason,
	type SessionLogEntry,
	SessionLogIntegrityError,
	readSessionLogTail,
	verifyPointer,
} from './chain.js'
export {
	type ActiveTurn,
	type ActiveTurnOptions,
	type BeginTurnOptions,
	InvalidSessionRecordError,
	type LogMedium,
	type ReadSessionLogOptions,
	type SessionLog,
	SessionLogConflictError,
	SessionLogCore,
	type SessionLogCoreOptions,
	type SessionLogHead,
	type SessionLogRead,
	type SessionLogReadSummary,
	type SessionRecordDraft,
	type TurnStartedDraft,
	walkSessionLog,
} from './core.js'
export {
	DiskLogMedium,
	DiskSessionLog,
	type DiskSessionLogOptions,
	readSessionLog,
	streamSessionLog,
} from './disk.js'
export {
	type ActiveTurnRecord,
	type FoldSessionMessagesOptions,
	type FoldedMessage,
	SessionMessageFold,
	SessionTurnState,
	type SpilledSummary,
	SpillUnavailableError,
	TurnRuleError,
	foldSessionMessages,
} from './fold.js'
export { type TornTailRepair, repairRecordDraft } from './heal.js'
export {
	type ClaimSessionOptions,
	DiskSessionLeaseStore,
	InMemorySessionLeaseStore,
	type LeaseClaimContext,
	type SessionLease,
	type SessionLeaseStore,
	StaleSessionLeaseError,
	isLeaseLive,
	readSessionLease,
} from './lease.js'
export {
	InMemoryLogMedium,
	InMemorySessionLog,
	type InMemorySessionLogOptions,
} from './memory.js'
export {
	DiskSpillStore,
	InMemorySpillStore,
	SPILL_DIR,
	SpillIntegrityError,
	type SpillManifest,
	type SpillRef,
	type SpillStore,
	spillFileName,
} from './spill.js'
