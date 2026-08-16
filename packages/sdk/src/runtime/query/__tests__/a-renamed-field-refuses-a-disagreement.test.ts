import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { pickRenamed } from '../../../utils/renamed-field.js'
import { drainQuery } from '../index.js'
import { PromptCache } from '../prompt-cache.js'

/**
 * `contextCache` became `promptCache`, and for one release both are live.
 *
 * The deprecated spelling has to keep working — a window whose old name
 * quietly stops functioning is not a window. And a caller who sets BOTH to
 * different instances has told us two incompatible things: there is no
 * correct guess available, so this refuses rather than picking one, per
 * `refuse-do-not-degrade`.
 *
 * Driven through `drainQuery` rather than by calling the helper alone,
 * because the helper agreeing with itself is not the claim. What has to
 * hold is that `query()` reads the two spellings through it, at one site,
 * so the refusal cannot be reached by one caller and skipped by another.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function cache(): PromptCache {
	return new PromptCache({ agentId: 'a', projectId: 'prj_rn' as ProjectId })
}

/** Counts provider calls, so "costs nothing" can be measured rather than asserted. */
function counting(): MockLLMProvider & { calls: number } {
	const provider = new MockLLMProvider({ turns: [{ text: 'done' }] }) as MockLLMProvider & {
		calls: number
	}
	provider.calls = 0
	const original = provider.chatStream.bind(provider)
	provider.chatStream = (p) => {
		provider.calls++
		return original(p)
	}
	return provider
}

async function run(
	fields: { contextCache?: PromptCache; promptCache?: PromptCache },
	provider: MockLLMProvider = new MockLLMProvider({ turns: [{ text: 'done' }] }),
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-renamed-'))
	dirs.push(workingDirectory)

	return drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_rn' as SessionId,
		topicId: 'top_rn' as TopicId,
		projectId: 'prj_rn' as ProjectId,
		tenantId: 'tnt_rn' as TenantId,
		...fields,
	})
}

describe('a field being renamed refuses a caller who disagrees with themselves', () => {
	it('throws when both spellings are set to different instances, naming both', async () => {
		// The message has to name BOTH fields: the caller's bug is two lines
		// they have to reconcile, and an error naming only one sends them to
		// the wrong half.
		const provider = counting()

		await expect(run({ contextCache: cache(), promptCache: cache() }, provider)).rejects.toThrow(
			/contextCache[\s\S]*promptCache|promptCache[\s\S]*contextCache/,
		)
		// And it costs nothing. Resolved at the read site instead, the same
		// bug throws AFTER a provider call has been paid for and a partial
		// transcript written — which is a mid-run failure wearing a config
		// error's message.
		expect(provider.calls).toBe(0)
	})

	it('accepts the same instance under both spellings', async () => {
		// Not a disagreement. A host spreading one object into both names
		// during its own migration is stating one thing twice, and failing
		// that would make the window harder to cross than staying put.
		const shared = cache()
		const spy = vi.spyOn(shared, 'getSystemPromptSegmented')

		await run({ contextCache: shared, promptCache: shared })

		expect(spy).toHaveBeenCalled()
	})

	it('still builds the prompt through a cache passed under the OLD name', async () => {
		// The whole point of a window. Asserted through the instance rather
		// than through the run's output, because a prompt built WITHOUT the
		// cache produces the same answer from a mock provider — the
		// difference is which object did the work.
		const deprecated = cache()
		const spy = vi.spyOn(deprecated, 'getSystemPromptSegmented')

		await run({ contextCache: deprecated })

		expect(spy).toHaveBeenCalled()
	})

	it('uses the new name when only it is set', async () => {
		const current = cache()
		const spy = vi.spyOn(current, 'getSystemPromptSegmented')

		await run({ promptCache: current })

		expect(spy).toHaveBeenCalled()
	})

	it('returns undefined when neither is set, rather than throwing', () => {
		// The overwhelmingly common case, and the one a refusal must not
		// touch. Called directly: there is no instance to spy on.
		expect(pickRenamed('old', undefined, 'new', undefined)).toBeUndefined()
	})
})
