// Sub-barrel for the Topic persistence module (Convention #4).
// Concrete implementations live in sibling files; re-export them here so
// consumers import via `../store/topic/index.js`.
//
// There is no disk implementation. `DiskThreadStore` was deleted in
// NZ-TOPIC-02 as declared-but-undriven — nothing in the monorepo ever
// constructed one, and the untested code had a live indexing bug to show for
// it. Reintroducing it here under the new name would undo that decision
// silently, which is the one way a rename commit can lose an argument nobody
// re-made. A durable TopicStore is still owed; it lands with the capability
// that needs one, a caller, and a test.

export { InMemoryTopicStore } from './memory.js'
