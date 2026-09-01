/**
 * The directory the agent actually works in.
 *
 * `--cwd` was parsed, and reached the session store and the skill search, and
 * stopped there: the agent run itself was started with the PROCESS's directory,
 * so a run pointed at another checkout globbed this one and reported finding
 * nothing — which reads as "the file isn't there" rather than "I looked in the
 * wrong place". Nothing caught it because no test ran a file tool against a
 * directory that was not the process's own, so both directories were the same
 * string in every assertion. These two do.
 */

import { existsSync, lstatSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import {
	type ToolRegistry,
	asProjectId,
	asSessionId,
	asTenantId,
	asTopicId,
	getBuiltinTools,
} from '@namzu/sdk'
import type { RunId, ToolContext } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

// Only `query` is replaced; everything else the module under test imports —
// the tool registry, the disk stores, the provider registry the vendor package
// registers into — stays real, because a fake of those would not be able to
// tell us which directory the real ones were handed.
const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let workDir: string
let stateRoot: string

beforeEach(() => {
	queryCalls.length = 0
	workDir = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-state-'))
	writeFileSync(join(workDir, 'notes.txt'), 'a file that only exists in the --cwd\n')
})

afterEach(() => {
	removeTempDir(workDir)
	removeTempDir(stateRoot)
})

function toolContext(workingDirectory: string): ToolContext {
	return {
		runId: 'run_test' as RunId,
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('a file tool resolves against the working directory it is given', () => {
	it('finds a file that exists only outside the process directory', async () => {
		const glob = getBuiltinTools().find((t) => t.name === 'glob')
		expect(glob, 'the glob builtin is what the reported run called').toBeDefined()

		const found = await glob?.execute({ pattern: '**/notes.txt' }, toolContext(workDir))
		expect(found?.success).toBe(true)
		expect(found?.data).toMatchObject({ count: 1 })

		// The same call in the process's own directory is the reported failure:
		// the file is real, and the answer is that there is no file. Asserted on
		// the count, because the "no files found" text quotes the pattern back
		// and so contains the filename either way.
		const missed = await glob?.execute({ pattern: '**/notes.txt' }, toolContext(process.cwd()))
		expect(missed?.data).toMatchObject({ count: 0 })
	})
})

describe('createAgentSession runs where it is told to', () => {
	const prefs: Preferences = {
		version: 3,
		providers: [{ id: 'anthropic' }],
		subagents: { active: [] },
	} as Preferences

	function detectedAnthropic(): DetectedProvider[] {
		return [
			{
				entry: {
					id: 'anthropic',
					label: 'Anthropic',
					defaultModel: 'claude-sonnet-4-5',
					requiresApiKey: true,
					envVars: ['ANTHROPIC_API_KEY'],
				},
				source: 'env',
				apiKey: 'sk-ant-not-a-real-key',
				alternatives: [],
			} as unknown as DetectedProvider,
		]
	}

	function scope() {
		return {
			sessionId: asSessionId('ses_working-directory-test'),
			topicId: asTopicId('top_working-directory-test'),
			projectId: asProjectId('prj_working-directory-test'),
			tenantId: asTenantId('tnt_working-directory-test'),
		}
	}

	it.runIf(process.platform !== 'win32')(
		'protects central generated state without creating a local runtime tree',
		async () => {
			const { createAgentSession } = await import('../agent.js')
			const session = await createAgentSession(prefs, detectedAnthropic(), {
				cwd: workDir,
				stateRoot,
				scope: scope(),
			})
			const projectRoot = join(stateRoot, 'projects', 'prj_working-directory-test')

			expect(session.hasProvider).toBe(true)
			expect(lstatSync(join(stateRoot, 'projects')).mode & 0o777).toBe(0o700)
			expect(lstatSync(projectRoot).mode & 0o777).toBe(0o700)
			expect(lstatSync(join(projectRoot, 'memory')).mode & 0o777).toBe(0o700)
			expect(lstatSync(join(projectRoot, 'tenants')).mode & 0o777).toBe(0o700)
			expect(existsSync(join(workDir, '.namzu'))).toBe(false)
			await session.close()
		},
	)

	it.runIf(process.platform !== 'win32')(
		'does not advertise host background jobs inside the default sandbox',
		async () => {
			const { createAgentSession } = await import('../agent.js')
			const session = await createAgentSession(prefs, detectedAnthropic(), {
				cwd: workDir,
				stateRoot,
				scope: scope(),
			})

			for await (const _ of session.send([{ role: 'user', content: 'inspect', timestamp: 0 }])) {
				// The query mock captures the exact registry shown to the provider.
			}
			const registry = queryCalls[0]?.tools as ToolRegistry
			const tools = registry.getCallableTools()
			const bash = tools.find((tool) => tool.name === 'bash')

			// Whether this host actually enforces an isolation control is a
			// platform fact. The default sandbox can be attached and honestly
			// report `unconfined` on a host whose kernel offers no supported tier;
			// background-job reachability must not depend on pretending otherwise.
			expect(session.sandbox.workspace).toBe('working-directory')
			expect(tools.map((tool) => tool.name)).not.toContain('job')
			expect(
				bash?.inputSchema.parse({
					command: 'sleep 1',
					run_in_background: true,
				}),
			).not.toHaveProperty('run_in_background')
			expect(JSON.stringify(bash?.modelInputSchema)).not.toContain('run_in_background')
			expect(bash?.description).toMatch(/foreground|serialized/i)
			await session.close()
		},
	)

	it('keeps background jobs reachable when sandboxing is explicitly disabled', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			stateRoot,
			scope: scope(),
			sandbox: { enabled: false },
		})

		for await (const _ of session.send([{ role: 'user', content: 'inspect', timestamp: 0 }])) {
			// The query mock captures the exact registry shown to the provider.
		}
		const registry = queryCalls[0]?.tools as ToolRegistry
		const tools = registry.getCallableTools()
		const bash = tools.find((tool) => tool.name === 'bash')

		expect(tools.map((tool) => tool.name)).toContain('job')
		expect(bash?.inputSchema.parse({ command: 'sleep 1', run_in_background: true })).toMatchObject({
			run_in_background: true,
		})
		await session.close()
	})

	it('passes the caller-supplied cwd to the run, not the process directory', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			stateRoot,
		})
		expect(session.hasProvider).toBe(true)

		for await (const _ of session.send([
			{ role: 'user', content: 'read notes.txt', timestamp: 0 },
		])) {
			// drained; the assertion is on what `query` was handed
		}

		expect(queryCalls).toHaveLength(1)
		expect(queryCalls[0].workingDirectory).toBe(workDir)
		expect(queryCalls[0].workingDirectory).not.toBe(process.cwd())
		expect(queryCalls[0]).toMatchObject({
			runConfig: { sandbox: { workspace: 'working-directory' } },
		})
		// Keep this cwd-routing test from manufacturing an unrelated legacy
		// store in the directory whose file-tool behavior it is measuring. CLI
		// command surfaces obtain this exact root from openSessions.
		expect(existsSync(join(workDir, '.namzu'))).toBe(false)
	})

	it('keeps an explicit ephemeral workspace choice', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			sandbox: { workspace: 'ephemeral' },
		})

		for await (const _ of session.send([{ role: 'user', content: 'hello', timestamp: 0 }])) {
			// drained; the assertion is on the run configuration
		}

		expect(queryCalls[0]).toMatchObject({
			runConfig: { sandbox: { workspace: 'ephemeral' } },
		})
	})

	it('falls back to the process directory when no cwd is supplied', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { stateRoot })

		for await (const _ of session.send([{ role: 'user', content: 'hello', timestamp: 0 }])) {
			// drained
		}

		expect(queryCalls[0].workingDirectory).toBe(process.cwd())
	})

	it('refuses a missing cwd before announcing a usable session', async () => {
		const { createAgentSession } = await import('../agent.js')
		const missing = join(workDir, 'missing')

		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: missing,
		})

		expect(session.hasProvider).toBe(false)
		expect(session.errorKind).toBe('invocation')
		expect(session.errorHint).toContain('Working directory is unavailable')
		expect(queryCalls).toHaveLength(0)
	})

	it('refuses to call a filesystem root a confined workspace', async () => {
		const { createAgentSession } = await import('../agent.js')

		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: parse(workDir).root,
		})

		expect(session.hasProvider).toBe(false)
		expect(session.errorHint).toContain('refuses filesystem root')
		expect(queryCalls).toHaveLength(0)
	})
})
