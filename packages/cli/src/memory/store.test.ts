import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	appendMemory,
	composeMemoryPrompt,
	memoryFilePath,
	readMemory,
	userFilePath,
} from './store.js'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-mem-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
})

describe('readMemory', () => {
	it('returns nulls when nothing is stored', () => {
		expect(readMemory(home)).toEqual({ user: null, memory: null })
	})

	it('reads USER.md and MEMORY.md and trims', () => {
		writeFileSync(userFilePath(home), '  I am Bahadir, a TS dev.\n')
		writeFileSync(memoryFilePath(home), '- prefers tabs\n')
		expect(readMemory(home)).toEqual({
			user: 'I am Bahadir, a TS dev.',
			memory: '- prefers tabs',
		})
	})

	it('treats whitespace-only files as empty', () => {
		writeFileSync(memoryFilePath(home), '   \n\n')
		expect(readMemory(home).memory).toBeNull()
	})
})

describe('composeMemoryPrompt', () => {
	it('returns null when there is nothing to inject', () => {
		expect(composeMemoryPrompt({ user: null, memory: null })).toBeNull()
	})

	it('includes only the sections that have content', () => {
		const onlyUser = composeMemoryPrompt({ user: 'role: dev', memory: null })
		expect(onlyUser).toContain('## About the user')
		expect(onlyUser).toContain('role: dev')
		expect(onlyUser).not.toContain('## Durable memory')

		const both = composeMemoryPrompt({ user: 'role: dev', memory: '- likes tabs' })
		expect(both).toContain('## About the user')
		expect(both).toContain('## Durable memory')
		expect(both).toContain('- likes tabs')
	})
})

describe('appendMemory', () => {
	it('appends a bullet, creating the file', () => {
		appendMemory('first fact', home)
		appendMemory('second fact', home)
		expect(readFileSync(memoryFilePath(home), 'utf8')).toBe('- first fact\n- second fact\n')
	})

	it('ignores empty input', () => {
		appendMemory('   ', home)
		expect(readMemory(home).memory).toBeNull()
	})

	it('round-trips into the injected prompt', () => {
		appendMemory('namzu is built on @namzu/sdk', home)
		const prompt = composeMemoryPrompt(readMemory(home))
		expect(prompt).toContain('namzu is built on @namzu/sdk')
	})
})
