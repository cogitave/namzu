// Sub-barrel for the session-entity persistence module (Convention #4).
//
// Projects, sessions, sub-session edges and summaries, every accessor
// carrying an explicit `TenantId` (Convention #17). A session's conversation
// is not here: it is the session log (`store/session-log`), and listing
// across sessions is the session index (`store/session-index`).

export { InMemorySessionStore } from './memory.js'
export { DiskSessionStore } from './disk.js'
export type { DiskSessionStoreConfig } from './disk.js'
export { getAncestry, getChildren, orderChildren } from './linkage.js'
export type { LinkageView } from './linkage.js'
