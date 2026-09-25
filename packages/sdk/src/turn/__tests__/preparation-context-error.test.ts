import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { drainQuery } from '../../runtime/query/index.js'
import { createUserMessage } from '../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../utils/id.js'
import { PreparationContextError } from '../preparation-context-error.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})

it.each(['safe', 'ordinary', 'ceiling', 'remaining-room'] as const)(
	'preserves preparation decisions and bounds failure context (%s)',
	async (kind) => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-preparation-note-'))
		dirs.push(cwd)
		const provider = new MockLLMProvider({ turns: [{ text: 'Done.' }] })
		let laterContext: string | undefined
		await drainQuery({
			provider,
			toolsets: [],
			workingDirectory: cwd,
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			agentId: 'note',
			agentName: 'Note',
			messages: [createUserMessage('Continue the task.')],
			turnConfig: { model: 'mock', maxIterations: 1, timeoutMs: 10_000, tokenBudget: 100_000 },
			compactionConfig: CompactionConfigSchema.parse({ contextWindowTokens: 4_000 }),
			prepareStep: [
				() => ({ context: 'Prior observation.', system: 'Prior system.', temperature: 0.1 }),
				({ contextBudget }) => {
					const cause = new Error('PRIVATE_ERROR_DATA')
					if (kind === 'ordinary') throw Object.assign(cause, { context: 'FORGED_NOTE' })
					const room = contextBudget!.remainingTokens
					if (kind === 'remaining-room') expect(room).toBeLessThan(12_000)
					throw new PreparationContextError(
						cause,
						kind === 'safe'
							? 'SAFE_AVAILABILITY'
							: 'SAFE_AVAILABILITY'.padEnd(kind === 'ceiling' ? 12_001 : room + 1, 'x'),
					)
				},
				({ prepared }) => {
					laterContext = prepared.context
					return { temperature: 0.2 }
				},
			],
		})
		const request = provider.requests[0]!
		expect(laterContext).toBe(
			kind === 'safe' ? 'Prior observation.\n\nSAFE_AVAILABILITY' : 'Prior observation.',
		)
		expect(request.temperature).toBe(0.2)
		expect(JSON.stringify(request)).not.toContain('PRIVATE_ERROR_DATA')
		expect(JSON.stringify(request)).not.toContain('FORGED_NOTE')
		if (kind !== 'safe') expect(JSON.stringify(request)).not.toContain('SAFE_AVAILABILITY')
	},
)
