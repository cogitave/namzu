import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { hashedSlugForCwd, slugForCwd } from '../paths.js'

/**
 * Two processes create one slug's `project.json` at the same moment.
 *
 * In-process concurrency (the unit suite has it) interleaves promises on one
 * event loop; it cannot show that the exclusivity holds between processes,
 * which is where it matters — two terminals opening the same checkout. So
 * this spawns real `node` processes against the built module and releases
 * them together through a start file.
 */

const DIST = join(import.meta.dirname, '../../../dist/session/paths.js')

const made: string[] = []
async function scratch(label: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), `namzu-race-${label}-`)))
	made.push(dir)
	return dir
}
afterEach(async () => {
	await removeTempDirs(made.splice(0))
})

interface Outcome {
	slug: string
	projectId: string
	created: boolean
}

/** Starts one contender; it spins until `gate` exists, then calls ensureProject once. */
function contender(home: string, cwd: string, gate: string): Promise<Outcome> {
	const script = `
		const { existsSync } = await import('node:fs')
		const { ensureProject } = await import(${JSON.stringify(DIST)})
		while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 1))
		const p = await ensureProject({ home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(cwd)} })
		process.stdout.write(JSON.stringify({ slug: p.slug, projectId: p.projectId, created: p.created }))
	`
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let out = ''
		let err = ''
		child.stdout.on('data', (chunk) => {
			out += chunk
		})
		child.stderr.on('data', (chunk) => {
			err += chunk
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) resolve(JSON.parse(out) as Outcome)
			else reject(new Error(`contender exited ${code}: ${err}`))
		})
	})
}

async function race(home: string, cwd: string, contenders: number): Promise<Outcome[]> {
	const gate = join(home, '.go')
	const running = Array.from({ length: contenders }, () => contender(home, cwd, gate))
	// Let every process load the module before releasing them together.
	await new Promise((r) => setTimeout(r, 750))
	writeFileSync(gate, '')
	return Promise.all(running)
}

describe('a project slug created by racing processes', () => {
	it('results in exactly one project.json, minted by one process and adopted by the rest', async () => {
		const home = await scratch('home')
		const cwd = await scratch('cwd')
		const outcomes = await race(home, cwd, 4)
		expect(outcomes.filter((o) => o.created)).toHaveLength(1)
		expect(new Set(outcomes.map((o) => o.projectId)).size).toBe(1)
		expect(new Set(outcomes.map((o) => o.slug))).toEqual(new Set([slugForCwd(cwd)]))
		const dir = join(home, 'projects', slugForCwd(cwd))
		expect(readdirSync(dir)).toEqual(['project.json'])
		expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).projectId).toBe(
			outcomes[0]?.projectId,
		)
	})

	it('sends a different directory under the same slug to the hashed slug, still with one winner', async () => {
		const home = await scratch('home')
		const cwd = await scratch('cwd')
		const slug = slugForCwd(cwd)
		mkdirSync(join(home, 'projects', slug), { recursive: true })
		writeFileSync(
			join(home, 'projects', slug, 'project.json'),
			JSON.stringify({
				v: 1,
				kind: 'project',
				projectId: '0191f3a0-0000-7000-8000-000000000000',
				cwd: '/another/checkout',
				slug,
				createdAt: '2026-01-01T00:00:00.000Z',
			}),
		)
		const outcomes = await race(home, cwd, 3)
		expect(new Set(outcomes.map((o) => o.slug))).toEqual(new Set([hashedSlugForCwd(cwd)]))
		expect(outcomes.filter((o) => o.created)).toHaveLength(1)
		expect(new Set(outcomes.map((o) => o.projectId)).size).toBe(1)
	})
})
