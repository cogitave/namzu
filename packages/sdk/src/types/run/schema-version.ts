/**
 * RunEvent envelope schema version. Bumped on breaking envelope change.
 *
 * - v1: pre-0.2.0 (implicit; untagged events are treated as v1 by consumers).
 * - v2: 0.2.0+ — adds `schemaVersion`, `lineage`, and sub-session lifecycle
 *   events.
 *
 * See session-hierarchy.md §10.1 (Event-schema evolution contract) and
 * §13.3.2 (`schemaVersion` back-compat).
 */
export const RUN_EVENT_SCHEMA_VERSION = 2 as const

export type RunEventSchemaVersion = typeof RUN_EVENT_SCHEMA_VERSION
