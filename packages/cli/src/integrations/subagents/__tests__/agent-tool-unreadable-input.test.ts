import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * A delegation whose arguments were cut off was answered with the kernel's
 * one fixed message, which told the model how to write long files with
 * `write` and `edit`. What the `Agent` tool needs said is how to keep its
 * one long argument short, and the kernel only says it for a tool that
 * declares it.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

describe('the Agent tool and unreadable input', () => {
	it('declares its prompt as long text, a hint for a cut-off call to name a file instead, and one for a malformed call', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-agent-unreadable-'))
		dirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'parent-model',
			resolveParent: parent.resolveParent,
			buildTools: () => [],
			buildProvider: () => new MockLLMProvider({ turns: [{ text: 'done' }] }),
		})
		try {
			expect(runtime.agentTool.largeStringArguments).toEqual({ prompt: 12_000 })
			expect(runtime.agentTool.truncatedInputHint).toMatch(/name the file in the prompt/)
			// A malformed call is told how to put the prompt in a JSON string,
			// and nothing about files or size.
			expect(runtime.agentTool.malformedInputHint).toBe(
				'Every character of "prompt" goes inside a JSON string: write a newline as \\n, a tab as \\t, a double quote as \\" and a backslash as \\\\.',
			)
			expect(runtime.agentTool.malformedInputHint).not.toMatch(/file|under \d+/)
		} finally {
			await runtime.close()
		}
	})
})
