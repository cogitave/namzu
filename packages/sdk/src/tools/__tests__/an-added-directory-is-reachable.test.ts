import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { buildBwrapArgs } from '../../sandbox/provider/local.js'
import type { ToolContext } from '../../types/tool/index.js'
import { generateRunId } from '../../utils/id.js'
import { ReadFileTool } from '../builtins/read-file.js'
import { resolveWithinAny, resolveWithinAnyReal, toolRoots } from '../paths.js'

let base: string
let cwd: string
let added: string
let elsewhere: string

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), 'namzu-add-dir-'))
	cwd = join(base, 'project')
	added = join(base, 'shared')
	elsewhere = join(base, 'secret')
	for (const dir of [cwd, added, elsewhere]) mkdirSync(dir)
	writeFileSync(join(cwd, 'own.txt'), 'own')
	writeFileSync(join(added, 'lib.txt'), 'lib')
	writeFileSync(join(elsewhere, 'no.txt'), 'no')
})

afterEach(() => {
	removeTempDir(base)
})

const context = (extra?: readonly string[]): ToolContext => ({
	runId: generateRunId(),
	workingDirectory: cwd,
	...(extra ? { additionalDirectories: extra } : {}),
	abortSignal: new AbortController().signal,
	env: {},
	log: () => {},
})

describe('an added directory', () => {
	it('is reachable by absolute path, while everything else outside stays out', async () => {
		const roots = toolRoots(context([added]))
		expect(resolveWithinAny(roots, join(added, 'lib.txt'))).toBe(join(added, 'lib.txt'))
		expect(await resolveWithinAnyReal(roots, join(added, 'lib.txt'))).toBe(join(added, 'lib.txt'))
		expect(() => resolveWithinAny(roots, join(elsewhere, 'no.txt'))).toThrow(/added directories/)
		await expect(resolveWithinAnyReal(roots, join(elsewhere, 'no.txt'))).rejects.toThrow(
			/added directories/,
		)
	})

	it('keeps relative paths on the working directory', () => {
		const roots = toolRoots(context([added]))
		expect(resolveWithinAny(roots, 'own.txt')).toBe(join(cwd, 'own.txt'))
		expect(resolveWithinAny(roots, '../shared/lib.txt')).toBe(join(added, 'lib.txt'))
		expect(() => resolveWithinAny(roots, '../secret/no.txt')).toThrow(/added directories/)
	})

	it('is what the read tool honours', async () => {
		const withDir = await ReadFileTool.execute({ path: join(added, 'lib.txt') }, context([added]))
		expect(withDir.success).toBe(true)
		expect(withDir.output).toContain('lib')
		const without = await ReadFileTool.execute({ path: join(added, 'lib.txt') }, context())
		expect(without.success).toBe(false)
	})

	it('is bound read-write into a bwrap sandbox at its own path', () => {
		const args = buildBwrapArgs(cwd, [added])
		const at = args.indexOf(added)
		expect(at).toBeGreaterThan(0)
		expect(args[at - 1]).toBe('--bind')
		expect(args[at + 1]).toBe(added)
		expect(args.indexOf('--chdir')).toBeGreaterThan(at)
		expect(buildBwrapArgs(cwd, [cwd]).filter((a) => a === cwd)).toHaveLength(3)
	})
})
