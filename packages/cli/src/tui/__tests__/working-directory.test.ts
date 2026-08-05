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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBuiltinTools } from '@namzu/sdk'
import type { RunId, ToolContext } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

// Nothing here is
// about it, and an absent daemon costs the load timeout, so it is stubbed to
// the empty catalog it degrades to anyway.

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

beforeEach(() => {
	queryCalls.length = 0
	workDir = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	writeFileSync(join(workDir, 'notes.txt'), 'a file that only exists in the --cwd\n')
})

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true })
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
		version: 2,
		provider: 'anthropic',
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

	it('passes the caller-supplied cwd to the run, not the process directory', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), { cwd: workDir })
		expect(session.hasProvider).toBe(true)

		for await (const _ of session.send([
			{ role: 'user', content: 'read notes.txt', timestamp: 0 },
		])) {
			// drained; the assertion is on what `query` was handed
		}

		expect(queryCalls).toHaveLength(1)
		expect(queryCalls[0].workingDirectory).toBe(workDir)
		expect(queryCalls[0].workingDirectory).not.toBe(process.cwd())
	})

	it('falls back to the process directory when no cwd is supplied', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic())

		for await (const _ of session.send([{ role: 'user', content: 'hello', timestamp: 0 }])) {
			// drained
		}

		expect(queryCalls[0].workingDirectory).toBe(process.cwd())
	})
})
