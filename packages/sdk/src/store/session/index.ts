// Sub-barrel for the session-scoped persistence module (Convention #4).
//
// `SessionStore` replaces the legacy `ConversationStore`; messages are scoped
// to a `SessionId` (not a bare thread) and every accessor carries explicit
// `TenantId` per session-hierarchy.md §12.1. Concrete implementations live
// in sibling files; re-export them here so consumers import via
// `../store/session/index.js`.

export { InMemorySessionStore } from './memory.js'
export { DiskSessionStore } from './disk.js'
export type { DiskSessionStoreConfig } from './disk.js'
export type { SessionMessage } from './messages.js'
export { getAncestry, getChildren, orderChildren } from './linkage.js'
export type { LinkageView } from './linkage.js'
