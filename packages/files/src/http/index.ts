// HTTP route handler factory: createFilesRouter({ registry, blobStore, authz }).
// Returns Next.js / Hono / Express adapters that wire the canonical
// URL layout (see Vandal docs.local/sessions/ses_028-namzu-files-architecture/
// design.md §4.6). Vandal merely composes these handlers; URL semantics
// and path-traversal protection live here. Implementation lands in Phase 4a.
export {}
