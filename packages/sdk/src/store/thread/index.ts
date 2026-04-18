// Sub-barrel for the Thread persistence module (Convention #4).
// Concrete implementations live in sibling files; re-export them here so
// consumers import via `../store/thread/index.js`.

export { InMemoryThreadStore } from './memory.js'
export { DiskThreadStore } from './disk.js'
export type { DiskThreadStoreConfig } from './disk.js'
