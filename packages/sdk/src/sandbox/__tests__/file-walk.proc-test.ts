import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type { SandboxFileEntry, SandboxWalkFilesOptions } from '../../types/sandbox/index.js'
import { type SandboxFileWalkExec, walkFilesLocally, walkFilesViaExec } from '../file-walk.js'

const execAsync = promisify(execFile)
const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})
const exec: SandboxFileWalkExec = async (command, argv, options) => {
	expect(command).toBe('node')
	try {
		const result = await execAsync(process.execPath, argv, {
			signal: options?.signal,
			maxBuffer: 1024 * 1024,
		})
		return {
			exitCode: 0,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: false,
			durationMs: 0,
		}
	} catch (error) {
		const result = error as Error & { code?: number; stdout?: string; stderr?: string }
		return {
			exitCode: result.code ?? 1,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			timedOut: false,
			durationMs: 0,
		}
	}
}
async function collect(source: AsyncIterable<SandboxFileEntry>) {
	const entries: SandboxFileEntry[] = []
	for await (const entry of source) entries.push(entry)
	return entries.sort((a, b) => a.path.localeCompare(b.path))
}
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-walk-program-')))
	dirs.push(root)
	for (const name of [
		'top.ts',
		'.env',
		'.secret.ts',
		'é.ts',
		'é/one.ts',
		'.config/a.json',
		'.config/.secret.ts',
		'src/a.ts',
		'src/.secret.ts',
		'src/b.js',
		'src/deep/c.ts',
		'a/b/x',
		'c/x',
		...(process.platform === 'win32' ? [] : ['new\nline\t😀.ts', 'new\nfolder/deep.ts']),
	]) {
		await mkdir(dirname(join(root, name)), { recursive: true })
		await writeFile(join(root, name), name)
	}
	return root
}

describe.skipIf(process.platform === 'win32')('the actual POSIX guest file-walk program', () => {
	it.each([
		{ pattern: '*' },
		{ pattern: '*.ts' },
		{ pattern: '**/*.ts' },
		{ pattern: 'src/*.{ts,js}' },
		{ pattern: '.env' },
		{ pattern: '.config/*.json' },
		{ pattern: '{.config,src}/*.{json,ts}' },
		{ pattern: '{a/b,c}/x' },
		{ pattern: '**/*', includeHidden: true, maxDepth: 1 },
		{ pattern: '**/*', maxEntries: 2 },
		{ pattern: '!(skip)' },
		{ pattern: '{*.ts,*.js}' },
		{ pattern: '@(*.ts|*.js)' },
		{ pattern: '[^a]env' },
		{ pattern: '{.env,*}' },
		{ pattern: '{,foo}*.ts' },
		{ pattern: '[.]env' },
		{ pattern: '[.]config/*.json' },
		{ pattern: '@(.config|src)/*.json' },
		{ pattern: '**/{*.ts,*.js}' },
		{ pattern: '**/{*.ts,*.js}', includeHidden: true },
		{ pattern: '[[:alpha:]].ts' },
		{ pattern: '[[:alpha:]]/*.ts' },
		{ pattern: '{[[:alpha:]].ts,top.ts}' },
	])('matches local enumeration with $pattern', async (overrides) => {
		const root = await fixture()
		const options: SandboxWalkFilesOptions = { maxEntries: 30, ...overrides }
		const local = await collect(walkFilesLocally(root, options))
		const remote = await collect(walkFilesViaExec(exec, root, options))
		expect(remote).toEqual(local)
	})
	it.each(['*', '*.ts', '**.ts', '{*.ts,*.js}', '@(top|skip).ts'])(
		'never visits descendants of a single-segment %s in the actual guest',
		async (pattern) => {
			const root = await fixture()
			const options: SandboxWalkFilesOptions = {
				pattern,
				maxEntries: 30,
				maxVisitedEntries: (await readdir(root)).length,
			}
			const local = await collect(walkFilesLocally(root, options))
			const remote = await collect(walkFilesViaExec(exec, root, options))
			expect(local.length).toBeGreaterThan(0)
			expect(remote).toEqual(local)
		},
	)
	it('reports the traversal budget from the actual guest instead of claiming no matches', async () => {
		const root = await fixture()
		await expect(
			collect(
				walkFilesViaExec(exec, root, {
					pattern: '**/*.missing',
					maxEntries: 10,
					maxVisitedEntries: 1,
				}),
			),
		).rejects.toMatchObject({ code: 'ERR_FILE_WALK_LIMIT' })
	})
})
