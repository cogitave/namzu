// Sub-barrel for the session-scoped persistence module (Convention #4).
//
// Messages are scoped to a `SessionId` and every accessor carries explicit
// `TenantId` (Convention #17). Concrete implementations live in sibling
// files; re-export them here so consumers import via
// `../store/session/index.js`.

export { InMemorySessionStore } from './memory.js'
export { DiskSessionStore } from './disk.js'
export type { DiskSessionStoreConfig } from './disk.js'
export type { SessionMessage } from './messages.js'
export { getAncestry, getChildren, orderChildren } from './linkage.js'
export type { LinkageView } from './linkage.js'
