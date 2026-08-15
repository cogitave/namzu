// Sub-barrel for the Thread persistence module (Convention #4).
// Concrete implementations live in sibling files; re-export them here so
// consumers import via `../store/thread/index.js`.
//
// DiskThreadStore lived here until NZ-TOPIC-02 (ses_020) deleted it:
// `new DiskThreadStore` had zero callers anywhere in the monorepo, it never
// entered the public-surface baseline, and store/thread/__tests__ never
// existed. A 220-line disk backend with no caller and no test is exactly the
// shape declared-but-undriven names — read the decision record in
// .work/sessions/ses_020-fit-gap-and-hygiene/README.md (D3) before adding a
// disk implementation back here.

export { InMemoryThreadStore } from './memory.js'
