import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { admitToolFacts } from '../../admit-facts.js'
import { PresentFileTool } from '../present-file.js'

const made: string[] = []

beforeEach(() => {
	// The temporary directory is a root unless guarded; these tests need an outside.
	vi.stubEnv('NAMZU_GUARD_TEMP_DIR', '1')
})

afterEach(async () => {
	vi.unstubAllEnvs()
	for (const path of made.splice(0)) await rm(path, { recursive: true, force: true })
})

async function folder(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'namzu-present-'))
	made.push(path)
	return path
}

function context(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...extras,
	}
}

describe('present_file', () => {
	it('shares a regular file inside the work folder and reports it as a shared fact', async () => {
		const work = await folder()
		await writeFile(join(work, 'report.md'), 'hello')
		const result = await PresentFileTool.execute(
			{ paths: ['report.md'], caption: 'The report' },
			context(work),
		)
		expect(result.success).toBe(true)
		const facts = result.facts
		expect(facts?.kind).toBe('shared')
		if (facts?.kind !== 'shared') throw new Error('expected shared')
		expect(facts.files).toHaveLength(1)
		expect(facts.files[0]?.path.endsWith('report.md')).toBe(true)
		expect(facts.files[0]?.bytes).toBe(5)
		// Where the path led when it was checked, so a host can tell if a link was re-pointed.
		expect(facts.files[0]?.real?.endsWith('report.md')).toBe(true)
		expect(facts.caption).toBe('The report')
		// The same facts survive the admission a saved record goes through.
		expect(admitToolFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts)
	})

	it('reaches a file in an added directory', async () => {
		const work = await folder()
		const added = await folder()
		await writeFile(join(added, 'a.txt'), 'x')
		const result = await PresentFileTool.execute(
			{ paths: [join(added, 'a.txt')] },
			context(work, { additionalDirectories: [added] }),
		)
		expect(result.success).toBe(true)
	})

	it('reaches the scratch folder (the temporary directory) when it is not guarded', async () => {
		vi.stubEnv('NAMZU_GUARD_TEMP_DIR', '')
		const work = await folder()
		const scratch = await folder()
		await writeFile(join(scratch, 'out.csv'), 'a,b')
		const result = await PresentFileTool.execute(
			{ paths: [join(scratch, 'out.csv')] },
			context(work),
		)
		expect(result.success).toBe(true)
	})

	it('refuses a folder', async () => {
		const work = await folder()
		await mkdir(join(work, 'sub'))
		const result = await PresentFileTool.execute({ paths: ['sub'] }, context(work))
		expect(result.success).toBe(false)
		expect(result.output).toContain('a folder, not a file')
		expect(result.facts).toBeUndefined()
	})

	it('refuses a missing file', async () => {
		const work = await folder()
		const result = await PresentFileTool.execute({ paths: ['nope.txt'] }, context(work))
		expect(result.success).toBe(false)
		expect(result.output).toContain('no such file')
	})

	it('refuses a path outside the roots and says how to widen them', async () => {
		const work = await folder()
		const outside = await folder()
		await writeFile(join(outside, 'secret.txt'), 'x')
		const result = await PresentFileTool.execute(
			{ paths: [join(outside, 'secret.txt')] },
			context(work),
		)
		expect(result.success).toBe(false)
		expect(result.output).toContain('outside the folders this session may reach')
	})

	it('refuses a link inside the work folder that leads outside it', async () => {
		const work = await folder()
		const outside = await folder()
		await writeFile(join(outside, 'secret.txt'), 'x')
		await symlink(join(outside, 'secret.txt'), join(work, 'link.txt'))
		const result = await PresentFileTool.execute({ paths: ['link.txt'] }, context(work))
		expect(result.success).toBe(false)
		expect(result.output).toContain('outside the folders')
	})

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
		'refuses a file that cannot be read',
		async () => {
			const work = await folder()
			const path = join(work, 'locked.txt')
			await writeFile(path, 'x')
			await chmod(path, 0o000)
			const result = await PresentFileTool.execute({ paths: ['locked.txt'] }, context(work))
			expect(result.success).toBe(false)
			expect(result.output).toContain('cannot be read')
		},
	)

	it('shares the good paths and names the refused ones', async () => {
		const work = await folder()
		await writeFile(join(work, 'a.txt'), 'x')
		const result = await PresentFileTool.execute(
			{ paths: ['a.txt', 'gone.txt', 'a.txt'] },
			context(work),
		)
		expect(result.success).toBe(true)
		expect(result.facts?.kind === 'shared' && result.facts.files.length).toBe(1)
		expect(result.output).toContain('Not shared')
		expect(result.output).toContain('gone.txt')
	})

	it('is not offered inside a sandboxed run', async () => {
		const work = await folder()
		const result = await PresentFileTool.execute(
			{ paths: ['a.txt'] },
			context(work, { sandbox: {} as ToolContext['sandbox'] }),
		)
		expect(result.success).toBe(false)
		expect(result.output).toContain('sandbox')
	})

	it('is a read-only tool with a description that says when not to use it', () => {
		expect(PresentFileTool.isReadOnly?.({ paths: ['a'] })).toBe(true)
		expect(PresentFileTool.description).toContain('already there')
		// The deferred catalogue shows only the first sentence, so the rule has to be in it.
		expect(PresentFileTool.description.split('. ')[0]).toContain('already there')
		expect(PresentFileTool.description).toContain('scratch folder')
	})
})
