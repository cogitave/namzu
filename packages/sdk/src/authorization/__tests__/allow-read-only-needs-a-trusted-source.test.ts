import { describe, expect, it } from 'vitest'

import type { ToolSourceRef } from '../../toolsets/types.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { AuthorizationGate } from '../gate.js'
import { defaultSandboxedGateConfig } from '../presets.js'

/**
 * `ToolDefinition.provenance` used to travel WITH the tool object, so
 * `allow_read_only` could ask `isTrustedReadOnly(toolDef, input)` and get an
 * honest answer about the server that owned it. It is gone: trust now lives
 * on the owning toolset's `source` (`ToolSourceRef`), reachable only through
 * `ToolManager.sourceOf`. If the live gate's call site does not thread that
 * source through, `isTrustedReadOnly` sees `source === undefined` and takes
 * the "host-defined, trust it" branch for every tool — including one an
 * untrusted MCP server declared `readOnlyHint: true` on itself.
 *
 * `AuthorizationGate.evaluate` is the call site this regresses: it must
 * carry `ToolCallContext.toolSource` all the way to `allow_read_only`.
 */

function toolDef(name: string, readOnly: boolean): ToolDefinition {
	return { name, isReadOnly: () => readOnly } as unknown as ToolDefinition
}

const untrustedMcpSource: ToolSourceRef = {
	id: 'mcp:untrusted-server',
	kind: 'mcp_server',
	server: 'untrusted-server',
	readOnlyHintTrusted: false,
}

const trustedMcpSource: ToolSourceRef = {
	id: 'mcp:trusted-server',
	kind: 'mcp_server',
	server: 'trusted-server',
	readOnlyHintTrusted: true,
}

describe('allow_read_only reads the call-site source, not a default trust', () => {
	it('does not allow an untrusted MCP server tool that self-declares read-only', () => {
		const gate = new AuthorizationGate(defaultSandboxedGateConfig(), NOOP_LOGGER)
		const result = gate.evaluate({
			toolName: 'read_secret_file',
			toolInput: {},
			toolDef: toolDef('read_secret_file', true),
			toolSource: untrustedMcpSource,
		})

		expect(result.decision).not.toBe('allow')
	})

	it('still allows the same tool once the operator has marked that server trusted', () => {
		const gate = new AuthorizationGate(defaultSandboxedGateConfig(), NOOP_LOGGER)
		const result = gate.evaluate({
			toolName: 'read_secret_file',
			toolInput: {},
			toolDef: toolDef('read_secret_file', true),
			toolSource: trustedMcpSource,
		})

		expect(result.decision).toBe('allow')
	})

	it('still allows a host-defined tool with no source to ask about', () => {
		// No untrusted party is in the chain for a builtin, and a caller with
		// no manager to ask (`toolSource` omitted) reads the same way.
		const gate = new AuthorizationGate(defaultSandboxedGateConfig(), NOOP_LOGGER)
		const result = gate.evaluate({
			toolName: 'read_file',
			toolInput: {},
			toolDef: toolDef('read_file', true),
		})

		expect(result.decision).toBe('allow')
	})
})
