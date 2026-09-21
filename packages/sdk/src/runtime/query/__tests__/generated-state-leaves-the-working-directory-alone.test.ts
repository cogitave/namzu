import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defaultStateRoot } from '../../../session/workspace/state-root.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A run with no path builder writes under `defaultStateRoot()`, not into
 * `<workingDirectory>/.namzu`.
 *
 * The old default put generated state inside whatever directory the agent was
 * pointed at: repositories gained a `.namzu/`, package tests left one in the
 * package, and a run started in `$HOME` wrote into the CLI's `~/.namzu`. The
 * runner points `NAMZU_STATE_DIR` into its owned root, so this checks the
 * root the kernel resolved, whatever it is.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

it('writes nothing into the working directory when no path builder is given', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-no-state-here-'))
	dirs.push(workingDirectory)
	const projectId = generateProjectId()

	const run = await drainQuery({
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory,
		turnConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 2,
		},
		projectId,
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})

	expect(run.status).toBe('completed')
	expect(await readdir(workingDirectory)).toEqual([])
	expect(existsSync(join(defaultStateRoot(), 'projects', projectId))).toBe(true)
})
