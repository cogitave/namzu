import { SESSION_EVENT_TYPES } from '@namzu/sdk'

/**
 * Every event type a session export can carry, in the kernel's own order.
 *
 * The export's `eventTypes` filter compares each event's `type` with the names it is given, so a
 * name outside this list matches nothing. Settings builds its choices from this list rather than
 * copying it, so a new event type shows up there with no second edit.
 */
export const SESSION_EXPORT_EVENT_TYPES: readonly string[] = SESSION_EVENT_TYPES
