/**
 * The fallback `ToolPresenter` every real session falls back to for a tool
 * with no opinion of its own (`createToolPresenter`, `@namzu/sdk`). A fixture
 * `AgentSession` that does not care about presentation uses this rather than
 * hand-rolling the same two generic-label closures in each test file.
 */

import { type ToolPresenter, genericLabel } from '@namzu/sdk'

export const genericPresenter: ToolPresenter = {
	presentCall: (_name, input) => ({ kind: 'generic', label: genericLabel(input) }),
	presentResult: (_name, input) => ({ kind: 'generic', label: genericLabel(input) }),
}
