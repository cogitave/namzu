/**
 * An operator's `permissions` config reaches the turn that enforces it.
 *
 * There was no test that started from a real config FILE and ended at a real
 * turn, and that gap is the whole reason this shipped: the chain is broken in
 * two independent places, in series, and every existing test sits on one side
 * or the other of a break.
 *
 *   config file → loadConfig() → compilePermissions() → createAgentSession()
 *               ↑ break 1                                        → query()
 *                                                          ↑ break 2
 *
 * - **Break 1.** `sanitize()` in `config/load.ts` copies exactly `format` and
 *   `quiet` off a parsed config, so `permissions` is dropped from every file
 *   namzu reads. `compilePermissions(ctx.config.permissions)` in `run.ts` and
 *   `run-stream.ts` is therefore always compiling `undefined`.
 * - **Break 2.** `runTurn` destructures `rules` and passes the module-level
 *   `VERIFICATION_GATE` — whose `rules` is a hardcoded `[]` — to `query()`.
 *   So even a caller that hands rules in explicitly has them dropped.
 *
 * Either break alone is enough to make a configured rule do nothing, which is
 * why this test is end-to-end: fixing one and testing that one would report
 * success while the feature stayed broken.
 *
 * The failure is silent by construction. `ask` compiles to no rule because the
 * gate's fallback is already to ask, so a dropped `deny` looks exactly like a
 * config that was honoured — the tool prompts instead of refusing, and a user
 * who clicks approve never learns their `deny` was ignored.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { loadConfig } from '../config/load.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { compilePermissions } from '../permissions/rules.js'

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
	workDir = mkdtempSync(join(tmpdir(), 'namzu-perms-'))
})

afterEach(() => {
	removeTempDir(workDir)
})

/** A real config file, in the real project-config location and format. */
function writeProjectConfig(permissions: Record<string, unknown>): void {
	writeFileSync(join(workDir, 'namzu.config.json'), JSON.stringify({ permissions }, null, 2))
}

const prefs = {
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

describe('a permissions rule written in a config file', () => {
	it('survives loadConfig', () => {
		writeProjectConfig({ bash: 'deny' })

		const cfg = loadConfig({ cwd: workDir, home: workDir, env: {} })

		expect(
			cfg.permissions,
			'the loader dropped the permissions table off a config file it parsed',
		).toBeDefined()
		expect(cfg.permissions?.bash).toBe('deny')
	})

	it('reaches the gate of the turn that has to enforce it', async () => {
		writeProjectConfig({ bash: 'deny' })

		// Exactly what `run.ts` does, from the same starting point a user has.
		const cfg = loadConfig({ cwd: workDir, home: workDir, env: {} })
		const compiled = compilePermissions(cfg.permissions)

		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			rules: compiled.rules,
		})
		for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
			// drain
		}

		expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
		const gate = queryCalls[0]?.verificationGate as { rules?: unknown[] } | undefined
		expect(gate?.rules).toEqual([{ type: 'deny_by_name', toolNames: ['bash'] }])
	})

	it('is not silently replaced by the empty default when handed in directly', async () => {
		// DO NOT DELETE THIS AS REDUNDANT WITH THE TEST ABOVE. It looks like a
		// subset of it and it is the opposite: it is the only test that isolates
		// the turn path from the loader.
		//
		// There were two faults, in series. Rules were dropped by the loader AND
		// again by the turn, and either one alone makes a configured rule do
		// nothing. A suite with only the end-to-end test above would go green the
		// moment ONE of them was fixed — reporting success on a feature that was
		// still dead — and a suite with only a loader test would never have looked
		// at the turn at all.
		//
		// So: no config file here, rules handed straight to the session. When this
		// fails and the end-to-end one fails, the turn drops them. When only the
		// end-to-end one fails, the loader is the sole fault. The pair of results
		// is the diagnosis; neither test gives it alone.
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: workDir,
			rules: [{ type: 'deny_by_name', toolNames: ['bash'] }],
		})
		for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
			// drain
		}

		const gate = queryCalls[0]?.verificationGate as { rules?: unknown[] } | undefined
		expect(gate?.rules).toEqual([{ type: 'deny_by_name', toolNames: ['bash'] }])
	})
})
