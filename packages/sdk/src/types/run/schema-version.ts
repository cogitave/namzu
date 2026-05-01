/**
 * RunEvent envelope schema version. Bumped on breaking envelope change.
 *
 * - v1: pre-0.2.0 (implicit; untagged events are treated as v1 by consumers).
 * - v2: 0.2.0+ — adds `schemaVersion`, `lineage`, and sub-session lifecycle
 *   events.
 * - v3: 2026-05-01 — removes `llm_response`; adds message + tool-input
 *   lifecycle variants (`message_started`, `text_delta`,
 *   `message_completed`, `tool_input_started`, `tool_input_delta`,
 *   `tool_input_completed`); `tool_executing`/`tool_completed` carry
 *   required `toolUseId`; `tool_completed` carries required `isError`.
 *   See ses_001-tool-stream-events.
 *
 * See session-hierarchy.md §10.1 (Event-schema evolution contract) and
 * §13.3.2 (`schemaVersion` back-compat).
 */
export const RUN_EVENT_SCHEMA_VERSION = 3 as const

export type RunEventSchemaVersion = typeof RUN_EVENT_SCHEMA_VERSION
