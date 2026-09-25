import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineTool } from '../defineTool.js'

/**
 * `DefineToolOptions.requiresApproval` and `.metadata`, built the same way
 * `capturesScreen` already is: absent unless the author sets it, and a
 * literal boolean normalized into a constant function.
 */

function base() {
	return {
		name: 'pay',
		description: 'Pay someone',
		inputSchema: z.object({ amountCents: z.number() }),
		category: 'custom' as const,
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		async execute() {
			return { success: true, output: 'paid' }
		},
	}
}

describe('defineTool — requiresApproval', () => {
	it('is absent when the option is not set', () => {
		const tool = defineTool(base())
		expect(tool.requiresApproval).toBeUndefined()
	})

	it('normalizes a literal true into a function that always says so', () => {
		const tool = defineTool({ ...base(), requiresApproval: true })
		expect(tool.requiresApproval?.({ amountCents: 1 })).toBe(true)
		expect(tool.requiresApproval?.({ amountCents: 999_999 })).toBe(true)
	})

	it('normalizes a literal false into a function that always says so', () => {
		const tool = defineTool({ ...base(), requiresApproval: false })
		expect(tool.requiresApproval?.({ amountCents: 1 })).toBe(false)
	})

	it('keeps a per-input function as given', () => {
		const tool = defineTool({
			...base(),
			requiresApproval: (input) => input.amountCents > 1000,
		})
		expect(tool.requiresApproval?.({ amountCents: 1 })).toBe(false)
		expect(tool.requiresApproval?.({ amountCents: 1001 })).toBe(true)
	})
})

describe('defineTool — metadata', () => {
	it('is absent when the option is not set', () => {
		const tool = defineTool(base())
		expect(tool.metadata).toBeUndefined()
	})

	it('is carried through exactly as given', () => {
		const metadata = { tag: 'experimental', owner: 'payments-team' }
		const tool = defineTool({ ...base(), metadata })
		expect(tool.metadata).toEqual(metadata)
	})
})
