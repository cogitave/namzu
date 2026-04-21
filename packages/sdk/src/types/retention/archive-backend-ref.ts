/**
 * Branded lookup identifier for an archived sub-session in a pluggable
 * {@link ArchiveBackend}. Produced by
 * {@link ArchiveBackend.store} on a successful archival write and consumed by
 * {@link ArchiveBackend.restore} to re-hydrate the bundle.
 *
 * Follows Convention #2 (`<prefix>_<opaque>` template literal brand). Prefix
 * chosen as `arc_` to match the `archive` domain — short, unambiguous, and
 * distinct from every existing prefix (`prj_`, `ses_`, `sub_`, `sum_`, …).
 *
 * The string after the prefix is opaque — backend-specific. A disk backend
 * embeds it in a directory path; an object-store backend may encode a key;
 * callers MUST NOT parse or pattern-match beyond the brand check.
 *
 * See session-hierarchy.md §12.3 Retention and Archival.
 */
export type ArchiveBackendRef = `arc_${string}`
