import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { toolNamesFromSource } from './tool-names-from-source.js'

/**
 * The hooks page lists the tools a hook can see by name. The list sits between
 * two markers and is checked against every tool the SDK defines, so a tool
 * added or renamed without the page changing fails here.
 */
describe('the tool names on the hooks page', () => {
	const page = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'..',
			'..',
			'..',
			'..',
			'..',
			'docs',
			'sdk',
			'hooks.md',
		),
		'utf8',
	)
	const block = /<!-- tool-names:start -->([\s\S]*?)<!-- tool-names:end -->/.exec(page)?.[1] ?? ''
	const listed = [...block.matchAll(/`([A-Za-z0-9_]+)`/g)].map((match) => match[1] as string)

	it('are exactly the names the SDK defines', () => {
		expect(block).not.toBe('')
		expect([...listed].sort()).toEqual(toolNamesFromSource())
	})

	it('name each tool once', () => {
		expect(new Set(listed).size).toBe(listed.length)
	})

	it('has json examples that parse, so a pasted example is not broken', () => {
		const fences = [...page.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1] as string)
		expect(fences.length).toBeGreaterThan(0)
		for (const fence of fences) expect(() => JSON.parse(fence), fence.slice(0, 60)).not.toThrow()
	})
})
