import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

const require = createRequire(import.meta.url)
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const setupFile = fileURLToPath(new URL('../test-setup.ts', import.meta.url))
const globalSetupFile = fileURLToPath(new URL('../__fixtures__/test-home-run.ts', import.meta.url))
const fixtures: string[] = []

afterEach(() => {
	for (const root of fixtures.splice(0)) removeTempDir(root)
})

it.each(['passing', 'failing', 'explicit', 'reassigned', 'late writer'] as const)(
	'cleans only the owned test home after a %s suite',
	(mode) => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-test-home-lifecycle-'))
		fixtures.push(root)
		const external = join(root, 'caller-home')
		mkdirSync(external)
		const sentinel = join(external, 'keep.txt')
		writeFileSync(sentinel, 'caller-owned state')
		const record = join(root, 'observed.json')
		const teardownRecord = join(root, 'teardown.txt')
		const lateWriteRecord = join(root, 'late-write.txt')
		const lateWriterSetup = join(root, 'late-writer-setup.mjs')
		writeFileSync(
			lateWriterSetup,
			`import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export default function setup() {
  return () => {
    const { home } = JSON.parse(readFileSync(${JSON.stringify(record)}, 'utf8'))
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'late-state.json'), '{}')
    writeFileSync(${JSON.stringify(lateWriteRecord)}, 'wrote after suite teardown')
  }
}
`,
		)
		writeFileSync(
			join(root, 'vitest.config.mjs'),
			`export default ${JSON.stringify({
				root,
				test: {
					include: ['home.test.mjs'],
					setupFiles: [setupFile],
					// Teardowns run in reverse: recreate state after the turn cleanup.
					globalSetup:
						mode === 'late writer' ? [lateWriterSetup, globalSetupFile] : [globalSetupFile],
					globals: true,
					maxWorkers: 1,
					fileParallelism: false,
				},
			})}`,
		)
		writeFileSync(
			join(root, 'home.test.mjs'),
			`import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.NAMZU_HOME
afterAll(() => {
  writeFileSync(${JSON.stringify(teardownRecord)}, String(existsSync(home)))
})
it('uses the isolated application home', () => {
  writeFileSync(join(home, 'state.json'), '{}')
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ home }))
  if (${JSON.stringify(mode)} === 'reassigned') process.env.NAMZU_HOME = ${JSON.stringify(external)}
  if (${JSON.stringify(mode)} === 'failing') throw new Error('intentional lifecycle failure')
})
`,
		)
		const env: NodeJS.ProcessEnv = {
			...process.env,
			TMPDIR: root,
			TMP: root,
			TEMP: root,
			NAMZU_HOME: mode === 'explicit' ? external : undefined,
		}
		const result = spawnSync(
			process.execPath,
			[vitest, 'run', '--config', join(root, 'vitest.config.mjs')],
			{
				cwd: root,
				env,
				encoding: 'utf8',
				timeout: 20_000,
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.status, result.stdout + result.stderr).toBe(mode === 'failing' ? 1 : 0)
		if (mode === 'failing') expect(result.stderr).toContain('intentional lifecycle failure')
		const { home } = JSON.parse(readFileSync(record, 'utf8')) as { home: string }
		// Test-specific teardown must still be able to use the home before setup releases it.
		expect(readFileSync(teardownRecord, 'utf8')).toBe('true')
		if (mode === 'late writer') {
			expect(readFileSync(lateWriteRecord, 'utf8')).toBe('wrote after suite teardown')
		}
		expect(existsSync(home)).toBe(mode === 'explicit')
		expect(readFileSync(sentinel, 'utf8')).toBe('caller-owned state')
	},
	30_000,
)
