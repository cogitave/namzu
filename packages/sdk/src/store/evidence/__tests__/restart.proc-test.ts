import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('shares an atomically published index between processes and reads a previous process address', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-restart-'))
	try {
		const scope = {
			tenantId: randomUUID(),
			projectId: randomUUID(),
			sessionId: randomUUID(),
			runId: randomUUID(),
		}
		const runDir = join(root, 'run')
		await mkdir(runDir)
		const options = { scope, runDir, indexDir: join(runDir, 'index') }
		await writeFile(
			join(runDir, 'run.json'),
			JSON.stringify({ id: scope.runId, status: 'completed', metadata: { scope } }),
		)
		const lines = [
			{ type: 'run_started', runId: scope.runId, seq: 1 },
			...Array.from({ length: 80 }, (_, i) => ({
				type: 'tool_completed',
				seq: i + 2,
				runId: scope.runId,
				toolUseId: `call-${i}`,
				toolName: 'observe',
				isError: false,
				result: i === 79 ? 'ORIGINAL RECEIPT 🦉' : 'earlier unrelated output',
			})),
		]
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
		)
		const original = await readFile(join(runDir, 'transcript.jsonl'), 'utf8')
		const moduleUrl = new URL('../../../../dist/store/evidence/disk.js', import.meta.url).href
		const exec = promisify(execFile)
		async function child(method: 'search' | 'read', input: unknown) {
			const script = `import {createDiskRunEvidenceSource} from ${JSON.stringify(moduleUrl)}; const source=createDiskRunEvidenceSource(JSON.parse(process.argv[1])); console.log(JSON.stringify(await source[process.argv[2]](JSON.parse(process.argv[3]))));`
			const { stdout } = await exec(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					script,
					JSON.stringify(options),
					method,
					JSON.stringify(input),
				],
				{ timeout: 20_000, maxBuffer: 100_000 },
			)
			return JSON.parse(stdout)
		}
		const first = await Promise.all([
			child('search', { query: 'RECEIPT' }),
			child('search', { query: 'RECEIPT' }),
		])
		expect(first.every((page) => page.matches.length === 0 && page.nextCursor)).toBe(true)
		expect(first[0].nextCursor).toBe(first[1].nextCursor)
		const cached = await child('search', { query: 'RECEIPT' })
		expect(cached.cacheHit).toBe(true)
		const found = await child('search', { query: 'RECEIPT', cursor: first[0].nextCursor })
		expect(found.matches).toHaveLength(1)
		const read = await child('read', { address: found.matches[0].address })
		expect(read.text).toBe('ORIGINAL RECEIPT 🦉')
		expect(await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).toBe(original)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
