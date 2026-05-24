import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readMemory } from './store.js'
import { REMEMBER_TOOL_NAME, buildRememberTool } from './tool.js'

let home: string
const ctx = {} as never

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-memtool-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
})

describe('buildRememberTool', () => {
	it('is named, non-destructive, and read-only-flagged', () => {
		const tool = buildRememberTool(home)
		expect(tool.name).toBe(REMEMBER_TOOL_NAME)
		expect(tool.isDestructive?.({})).toBe(false)
	})

	it('appends a fact to MEMORY.md and reports success', async () => {
		const tool = buildRememberTool(home)
		const result = await tool.execute({ fact: 'user prefers tabs' }, ctx)
		expect(result.success).toBe(true)
		expect(result.output).toContain('user prefers tabs')
		expect(readMemory(home).memory).toBe('- user prefers tabs')
	})

	it('rejects an empty fact without writing', async () => {
		const tool = buildRememberTool(home)
		const result = await tool.execute({ fact: '   ' }, ctx)
		expect(result.success).toBe(false)
		expect(readMemory(home).memory).toBeNull()
	})

	it('validates input shape', async () => {
		const tool = buildRememberTool(home)
		const result = await tool.execute({} as never, ctx)
		expect(result.success).toBe(false)
	})
})
