import { existsSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { resolveNamzuHome } from '../../../session/home.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { defaultSessionPaths } from '../session-storage.js'

/**
 * A turn given no session log writes under `NAMZU_HOME`
 * (`~/.namzu/projects/<slug>/`), not into `<workingDirectory>/.namzu`.
 *
 * The old default put generated state inside whatever directory the agent was
 * pointed at: repositories gained a `.namzu/`, package tests left one in the
 * package, and a run started in `$HOME` wrote into the CLI's `~/.namzu`. The
 * runner points `NAMZU_HOME` into its owned root, so this checks the home the
 * kernel resolved, whatever it is.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

it('writes nothing into the working directory when no session log is given', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-no-state-here-'))
	dirs.push(workingDirectory)
	const sessionId = generateSessionId()

	const turn = await drainQuery({
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
		projectId: generateProjectId(),
		sessionId,
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})

	expect(turn.status).toBe('completed')
	expect(await readdir(workingDirectory)).toEqual([])
	const paths = await defaultSessionPaths(workingDirectory)
	expect(paths.home).toBe(resolveNamzuHome())
	expect(existsSync(paths.sessionLog({ sessionId }))).toBe(true)
})
