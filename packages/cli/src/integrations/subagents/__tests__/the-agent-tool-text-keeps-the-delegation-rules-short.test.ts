/**
 * The `Agent` tool description points at the delegation rules and does not
 * restate them: the rules live in the doctrine the parent already reads.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, getBuiltinTools, toolset } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

describe('the Agent tool description', () => {
	it('says to do small work yourself, points explore at locating, and does not repeat the doctrine', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-agent-text-'))
		dirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'parent-model',
			resolveParent: parent.resolveParent,
			buildTools: () => [toolset('test', getBuiltinTools())],
			buildProvider: () => new MockLLMProvider({ turns: [{ text: 'x' }] }),
		})
		try {
			const text = runtime.agentTool.description.toLowerCase()
			expect(text).toContain('do small work or work with a known target yourself')
			expect(text).toContain('to locate a small answer')
			// The rules the doctrine owns are not stated a second time here.
			expect(text).not.toContain('never a conclusion')
			expect(text).not.toContain('treat the report as a claim')
			expect(text).not.toContain('always for parallel children')
		} finally {
			await runtime.close()
		}
	})
})
