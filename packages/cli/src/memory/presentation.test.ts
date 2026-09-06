import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	MEMORY_PREVIEW_MAX_CHARS,
	MEMORY_PREVIEW_MAX_LINES,
	renderMemoryReport,
} from './presentation.js'
import { memoryFilePath, projectMemoryFilePath, userFilePath } from './store.js'

let home: string
let cwd: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-memory-report-'))
	cwd = join(home, 'checkout', 'package')
	mkdirSync(join(home, 'checkout', '.git'), { recursive: true })
	mkdirSync(cwd)
})

afterEach(() => removeTempDir(home))

describe('renderMemoryReport', () => {
	it('shows saved sections with their resolved files and no model instructions', () => {
		const report = renderMemoryReport(
			{ project: '- Run pnpm test', memory: '- Prefer tabs', user: 'TypeScript developer' },
			{ cwd, home },
		)
		expect(report).toContain(`Project memory\n${projectMemoryFilePath(cwd)}\n\n- Run pnpm test`)
		expect(report).toContain(`User memory (all projects)\n${memoryFilePath(home)}\n\n- Prefer tabs`)
		expect(report).toContain(`About you\n${userFilePath(home)}\n\nTypeScript developer`)
		expect(report).not.toContain('Treat it as')
		expect(report).not.toContain('Do not repeat')
	})

	it('gives explicit save guidance without creating missing files', () => {
		expect(renderMemoryReport({ project: null, memory: null, user: null }, { cwd, home })).toBe(
			'No saved memory. Use /memory add <text> for this project, or /memory --user add <text> for all projects.',
		)
		expect(existsSync(join(home, '.namzu'))).toBe(false)
		expect(existsSync(join(home, 'checkout', '.namzu'))).toBe(false)
	})

	it('bounds multiline previews and names the complete file and omitted count', () => {
		const kept = Array.from(
			{ length: MEMORY_PREVIEW_MAX_LINES },
			(_, index) => `- Fact ${index}`,
		).join('\n')
		const omitted = '\n- Last fact'
		const path = projectMemoryFilePath(cwd)
		const report = renderMemoryReport(
			{ project: kept + omitted, memory: null, user: null },
			{ cwd, home },
		)
		expect(report).toContain(kept)
		expect(report).not.toContain('Last fact')
		expect(report).toContain(`[${omitted.length} more characters omitted. Full text: ${path}]`)
	})

	it('bounds long lines without splitting an emoji', () => {
		const kept = 'x'.repeat(MEMORY_PREVIEW_MAX_CHARS - 1)
		const report = renderMemoryReport(
			{ project: `${kept}😀tail`, memory: null, user: null },
			{ cwd, home },
		)
		expect(report).toContain(`${kept}\n\n[6 more characters omitted.`)
		expect(report).not.toContain('\ud83d')
		expect(report).not.toContain('tail')
	})
})
