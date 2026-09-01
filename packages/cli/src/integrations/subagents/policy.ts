/**
 * Upper deadline for an interactive CLI run and every delegated child it
 * owns. Cancellation remains the normal way to stop work before this bound.
 */
export const CLI_INTERACTIVE_RUN_TIMEOUT_MS = 60 * 60 * 1000
