import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	MEMORY_SECTION_MAX_CHARS,
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
	removeTempDir(home)
})

describe('readMemory', () => {
	it('returns nulls when nothing is stored', () => {
		expect(readMemory(home)).toEqual({ user: null, memory: null, project: null })
	})

	it('reads USER.md and MEMORY.md and trims', () => {
		writeFileSync(userFilePath(home), '  I am Bahadir, a TS dev.\n')
		writeFileSync(memoryFilePath(home), '- prefers tabs\n')
		expect(readMemory(home)).toEqual({
			user: 'I am Bahadir, a TS dev.',
			memory: '- prefers tabs',
			project: null,
		})
	})

	it('treats whitespace-only files as empty', () => {
		writeFileSync(memoryFilePath(home), '   \n\n')
		expect(readMemory(home).memory).toBeNull()
	})
})

describe('composeMemoryPrompt', () => {
	it('returns null when there is nothing to inject', () => {
		expect(composeMemoryPrompt({ user: null, memory: null, project: null })).toBeNull()
	})

	it('includes only the sections that have content', () => {
		const onlyUser = composeMemoryPrompt({ user: 'role: dev', memory: null, project: null })
		expect(onlyUser).toContain('## About the user')
		expect(onlyUser).toContain('role: dev')
		expect(onlyUser).not.toContain('## Durable memory')

		const both = composeMemoryPrompt({ user: 'role: dev', memory: '- likes tabs', project: null })
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

describe('project memory', () => {
	it('shares checkout memory across packages without creating package-local state', () => {
		const root = join(home, 'checkout')
		const nested = join(root, 'packages', 'cli')
		mkdirSync(join(root, '.git'), { recursive: true })
		mkdirSync(nested, { recursive: true })
		const path = appendMemory('one checkout memory', { scope: 'project', cwd: nested, home })
		expect(path).toBe(join(root, '.namzu', 'MEMORY.md'))
		expect(readMemory(home, nested).project).toBe('- one checkout memory')
		expect(readMemory(home, root).project).toBe('- one checkout memory')
		expect(existsSync(join(nested, '.namzu'))).toBe(false)
	})

	it.each(['- existing package fact\n', ''])('preserves an existing package memory: %j', (text) => {
		const root = join(home, 'checkout')
		const nested = join(root, 'packages', 'cli')
		mkdirSync(join(root, '.git'), { recursive: true })
		mkdirSync(join(nested, '.namzu'), { recursive: true })
		writeFileSync(join(nested, '.namzu', 'MEMORY.md'), text)
		appendMemory('root fact', { scope: 'project', cwd: root, home })
		expect(readMemory(home, nested).project).toBe(text.trim() || null)
		expect(appendMemory('package fact', { scope: 'project', cwd: nested, home })).toBe(
			join(nested, '.namzu', 'MEMORY.md'),
		)
		expect(readMemory(home, root).project).toBe('- root fact')
	})

	it('lives in the working directory, is the default target of a note, and is injected as its own section', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-project-'))
		try {
			const path = appendMemory('tests run with pnpm', { scope: 'project', cwd, home })
			expect(path).toBe(join(cwd, '.namzu', 'MEMORY.md'))
			expect(readMemory(home, cwd).project).toBe('- tests run with pnpm')
			expect(readMemory(home).project).toBeNull()
			expect(composeMemoryPrompt(readMemory(home, cwd))).toContain('## Project memory')
			expect(() => appendMemory('x', { scope: 'project', home })).toThrow(/working directory/)
		} finally {
			removeTempDir(cwd)
		}
	})

	it('caps a section and says what it left out', () => {
		const long = Array.from({ length: 900 }, (_, i) => `- fact number ${i} about the project`).join(
			'\n',
		)
		const prompt = composeMemoryPrompt({ user: null, memory: null, project: long })
		expect(prompt?.length).toBeLessThan(MEMORY_SECTION_MAX_CHARS + 400)
		expect(prompt).toContain('were not included')
	})
})
