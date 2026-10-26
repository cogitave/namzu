/**
 * A sub-agent that holds the memory tools gets the same memory section the
 * session does, and one that does not hold them gets none.
 *
 * Same seam as the file-defined agents test: definitions are captured where
 * they are registered and the config each builds is read directly.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type AgentDefinition,
	AgentRegistry,
	MarkdownMemoryStore,
	MockLLMProvider,
	type Toolset,
	buildMemoryTools,
	getBuiltinTools,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { composeMemoryGuidance } from '../../../memory/typed.js'
import { testToolset } from '../../../test-support/toolset.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { GENERAL_PURPOSE_SUBAGENT, createSubagentRuntime } from '../runtime.js'

const dirs: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function promptOf(withMemory: boolean): Promise<string> {
	const registered: AgentDefinition[] = []
	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation(function (
		this: AgentRegistry,
		def,
	) {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})
	const directory = await mkdtemp(join(tmpdir(), 'namzu-subagent-memory-'))
	dirs.push(directory)
	const memory = withMemory ? buildMemoryTools(new MarkdownMemoryStore({ directory })) : []
	const parent = await subagentParentFixture(process.cwd())
	await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: process.cwd(),
		model: 'session-model',
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: (): readonly Toolset[] => [testToolset(...getBuiltinTools(), ...memory)],
		definitions: [],
	})
	const definition = registered.find((d) => d.info.id === GENERAL_PURPOSE_SUBAGENT)
	const config = (await definition?.configBuilder?.({})) as unknown as { systemPrompt?: string }
	return config.systemPrompt ?? ''
}

describe('memory guidance for a sub-agent', () => {
	it('is part of the prompt of a child that holds the memory tools', async () => {
		const prompt = await promptOf(true)
		expect(prompt).toContain(composeMemoryGuidance({ taskList: false }))
		expect(prompt.split('## Memory').length).toBe(2)
	})

	it('is left out of the prompt of a child without them', async () => {
		expect(await promptOf(false)).not.toContain('## Memory')
	})
})
