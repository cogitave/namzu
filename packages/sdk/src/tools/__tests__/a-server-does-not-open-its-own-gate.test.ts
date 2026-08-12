import { describe, expect, it } from 'vitest'

import type { ToolDefinition } from '../../types/tool/index.js'
import { isTrustedReadOnly } from '../trusted-read-only.js'

/**
 * A connected server declares whether its own tools are read-only, and
 * that declaration decided whether a call was approved without asking —
 * on three separate paths. The thing being gated supplied the input to the
 * gate.
 *
 * The wire calls those fields HINTS. The asymmetry below is the fix: a
 * self-declaration may RAISE the requirement and never LOWER it.
 */

function toolFrom(server: string | undefined, readOnly: boolean, trusted = false): ToolDefinition {
	return {
		name: 't',
		description: 'd',
		isReadOnly: () => readOnly,
		...(server ? { provenance: { server, readOnlyHintTrusted: trusted } } : {}),
	} as unknown as ToolDefinition
}

describe('a read-only claim from a connected server', () => {
	it('does not settle a gate on its own', () => {
		// The whole defect in one line: the server says read-only, and that
		// used to be enough to allow the call without asking anyone.
		expect(isTrustedReadOnly(toolFrom('some-server', true), {})).toBe(false)
	})

	it('settles it once the operator has marked that server trusted', () => {
		expect(isTrustedReadOnly(toolFrom('some-server', true, true), {})).toBe(true)
	})

	it('does not leak from a trusted server to an untrusted one', () => {
		// Trust is per server. A global switch would hand every connected
		// server the same reach, which is the hole restated.
		expect(isTrustedReadOnly(toolFrom('trusted-one', true, true), {})).toBe(true)
		expect(isTrustedReadOnly(toolFrom('another-one', true, false), {})).toBe(false)
	})

	it('still refuses a trusted server when the tool is not read-only', () => {
		// Trusting a server means believing what it says, not overriding it.
		expect(isTrustedReadOnly(toolFrom('trusted-one', false, true), {})).toBe(false)
	})
})

describe('a tool defined by the host', () => {
	it('needs no opt-in, because no untrusted party is in the chain', () => {
		// Requiring provenance for a builtin would break every read-only
		// exemption for no gain in trust: this tool came from this process.
		expect(isTrustedReadOnly(toolFrom(undefined, true), {})).toBe(true)
	})

	it('is still not read-only when it says it is not', () => {
		expect(isTrustedReadOnly(toolFrom(undefined, false), {})).toBe(false)
	})
})

describe('the shape of the predicate', () => {
	it('answers false for a tool that declares nothing', () => {
		// Absent `isReadOnly` is not a read-only tool. Defaulting the other
		// way would exempt every tool that never thought about it.
		expect(isTrustedReadOnly({ name: 't' } as unknown as ToolDefinition, {})).toBe(false)
	})

	it('answers false for no tool at all', () => {
		expect(isTrustedReadOnly(undefined, {})).toBe(false)
	})

	it('passes the input through, so a per-input claim still works', () => {
		// `isReadOnly` takes the call's input: a tool can be read-only for
		// one argument and not another. Ignoring the input would collapse
		// that into a per-tool answer.
		const tool = {
			name: 't',
			isReadOnly: (input: unknown) => (input as { mode?: string }).mode === 'read',
		} as unknown as ToolDefinition

		expect(isTrustedReadOnly(tool, { mode: 'read' })).toBe(true)
		expect(isTrustedReadOnly(tool, { mode: 'write' })).toBe(false)
	})
})
