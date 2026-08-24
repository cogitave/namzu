import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const CLI_ENTRY = fileURLToPath(new URL('../bin.ts', import.meta.url))
const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx')

interface CliResult {
	readonly status: number | null
	readonly stdout: string
	readonly stderr: string
}

function runCliProcess(
	args: readonly string[],
	options: { readonly config?: string; readonly env?: Readonly<Record<string, string>> } = {},
): CliResult {
	const root = mkdtempSync(join(tmpdir(), 'namzu-invalid-config-cli-'))
	const home = join(root, 'home')
	const cwd = join(root, 'project')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	if (options.config !== undefined) {
		writeFileSync(join(cwd, 'namzu.config.json'), options.config)
	}
	const {
		NAMZU_FORMAT: _namzuFormat,
		NAMZU_QUIET: _namzuQuiet,
		NAMZU_PROFILE: _namzuProfile,
		...env
	} = process.env
	Object.assign(env, options.env, { HOME: home, USERPROFILE: home })

	const result = spawnSync(process.execPath, ['--import', TSX_IMPORT, CLI_ENTRY, ...args], {
		cwd,
		env,
		encoding: 'utf8',
		timeout: 15_000,
	})
	if (result.error) throw result.error
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('invalid explicit config reaches the real CLI refusal', () => {
	it('rejects an invalid --format as usage before the command action runs', () => {
		const result = runCliProcess(['--format', 'xml', 'serve'])

		expect(result.status).toBe(64)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('Allowed choices are text, json, yaml')
	})

	it('maps an invalid environment setting to EX_CONFIG and names the variable', () => {
		const result = runCliProcess(['serve'], { env: { NAMZU_FORMAT: 'xml' } })

		expect(result.status).toBe(78)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('environment variable NAMZU_FORMAT')
		expect(result.stderr).toContain('Fix or unset NAMZU_FORMAT')
	})

	it.each(['toString', 'constructor', '__proto__'])(
		'refuses inherited profile name %s selected by --profile',
		(name) => {
			const result = runCliProcess(['--profile', name, 'serve'], {
				config: JSON.stringify({ profiles: { safe: { format: 'json' } } }),
			})

			expect(result.status).toBe(78)
			expect(result.stdout).toBe('')
			expect(result.stderr).toContain(`No profile named "${name}"`)
		},
	)

	it.each(['toString', 'constructor', '__proto__'])(
		'refuses inherited profile name %s selected by NAMZU_PROFILE',
		(name) => {
			const result = runCliProcess(['serve'], {
				config: JSON.stringify({ profiles: { safe: { format: 'json' } } }),
				env: { NAMZU_PROFILE: name },
			})

			expect(result.status).toBe(78)
			expect(result.stdout).toBe('')
			expect(result.stderr).toContain(`No profile named "${name}"`)
		},
	)

	it('selects an Object.prototype-shaped name when it is an own profile', () => {
		const result = runCliProcess(['--profile', 'toString', 'serve'], {
			config: '{"profiles":{"toString":{"format":"json"}}}',
		})

		expect(result.status).toBe(0)
		expect(result.stderr).toContain('namzu has no daemon')
	})
})
