// Sub-barrel for the Thread type surface (Convention #4).
// Concrete types live in sibling files; re-export them here so consumers
// import via `../types/thread/index.js`.

export type { ThreadStore, CreateThreadParams } from './store.js'
