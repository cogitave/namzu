import {
	type LLMProvider,
	MockLLMProvider,
	type SessionId,
	type TurnId,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
	type ClassifierTarget,
	SMALL_MODEL_KEYWORD,
	classifierUnavailableReason,
	createSessionClassifier,
	withClassifierScope,
} from '../auto-classifier.js'

const SESSION = '052b7785-2bcc-458a-8184-76dfbdbfdf58' as SessionId
const TURN = '64e436d8-4c5f-46f7-b3fb-35ca1a31a891' as TurnId
const MAIN: ClassifierTarget = { providerId: 'anthropic', model: 'main-model' }
const KNOWN = new Set(['anthropic', 'openai'])

const ALLOW = {
	text: '<verdict>allow</verdict>',
	usage: { promptTokens: 40, completionTokens: 2, totalTokens: 42 },
}

const request = {
	call: { id: 'call_1', name: 'bash', input: { command: 'npm test' } },
	transcript: [createUserMessage('run the tests')],
}

/** Runs `review` inside the scope a real turn's handler would give it. */
function inTurn<T>(run: () => Promise<T>): Promise<T> {
	let result: Promise<T> | undefined
	const handler = withClassifierScope(async () => {
		result = run()
		await result
		return { action: 'approve_tools' }
	})
	return handler({ type: 'tool_review', sessionId: SESSION, turnId: TURN } as never).then(
		() => result as Promise<T>,
	)
}

function build(overrides: Partial<Parameters<typeof createSessionClassifier>[0]> = {}) {
	const provider = new MockLLMProvider({ turns: [ALLOW] })
	const providerFor = vi.fn(async (_session: SessionId, _target: ClassifierTarget) => provider)
	const charge = vi.fn()
	const classifier = createSessionClassifier({
		active: () => MAIN,
		isKnownProvider: (id) => KNOWN.has(id),
		providerFor: providerFor as unknown as (
			sessionId: SessionId,
			target: ClassifierTarget,
		) => Promise<LLMProvider>,
		charge,
		...overrides,
	})
	return { classifier, provider, providerFor, charge }
}

describe('which model the classifier asks', () => {
	it('is the session’s own model unless another is named', async () => {
		const { classifier, providerFor, provider } = build()

		const decision = await inTurn(() => classifier.review(request))

		expect(decision).toMatchObject({ verdict: 'allow', stage: 1 })
		expect(providerFor).toHaveBeenCalledWith(SESSION, MAIN)
		expect(provider.requests[0]?.model).toBe('main-model')
	})

	it('follows a model switch in the middle of the session', async () => {
		let active = MAIN
		const { classifier, providerFor } = build({ active: () => active })

		await inTurn(() => classifier.review(request))
		active = { providerId: 'openai', model: 'other-model' }
		await inTurn(() => classifier.review(request))

		expect(providerFor.mock.calls.map(([, target]) => target)).toEqual([MAIN, active])
	})

	it('reads a named model like smallModel: provider/model, or a bare model of the same provider', async () => {
		const bare = build({ settings: { model: 'cheap-model' } })
		await inTurn(() => bare.classifier.review(request))
		expect(bare.providerFor).toHaveBeenCalledWith(SESSION, {
			providerId: 'anthropic',
			model: 'cheap-model',
		})

		const qualified = build({ settings: { model: 'openai/gpt-small' } })
		await inTurn(() => qualified.classifier.review(request))
		expect(qualified.providerFor).toHaveBeenCalledWith(SESSION, {
			providerId: 'openai',
			model: 'gpt-small',
		})
	})

	it('uses the side model when the setting says smallModel', async () => {
		const smallRoute = vi.fn(async () => ({ providerId: 'openai', model: 'tiny' }))
		const { classifier, providerFor } = build({
			settings: { model: SMALL_MODEL_KEYWORD },
			smallRoute,
		})

		await inTurn(() => classifier.review(request))

		expect(smallRoute).toHaveBeenCalledOnce()
		expect(providerFor).toHaveBeenCalledWith(SESSION, { providerId: 'openai', model: 'tiny' })
	})
})

describe('failing closed', () => {
	it('blocks, without throwing, when the model cannot be reached', async () => {
		const { classifier } = build({
			providerFor: async () => {
				throw new Error('no credential for this provider')
			},
		})

		const decision = await inTurn(() => classifier.review(request))

		expect(decision).toMatchObject({ verdict: 'block', cause: 'unavailable' })
	})

	it('blocks when smallModel is named and there is no side model', async () => {
		const { classifier } = build({ settings: { model: SMALL_MODEL_KEYWORD } })

		expect(await inTurn(() => classifier.review(request))).toMatchObject({
			verdict: 'block',
			cause: 'unavailable',
		})
	})

	it('blocks a review that was not made inside a turn, which has no session to ask for', async () => {
		const { classifier, providerFor } = build()

		expect(await classifier.review(request)).toMatchObject({ verdict: 'block' })
		expect(providerFor).not.toHaveBeenCalled()
	})

	it('shows nothing of the failure in the reason it gives the model', async () => {
		const { classifier } = build({
			providerFor: async () => {
				throw new Error('sk-secret-token rejected')
			},
		})

		const decision = await inTurn(() => classifier.review(request))

		expect(JSON.stringify(decision)).not.toContain('sk-secret')
	})
})

describe('what a pass costs', () => {
	it('is charged to the turn that asked, with the stage that spent it', async () => {
		const { classifier, charge } = build()

		await inTurn(() => classifier.review(request))

		expect(charge).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: SESSION,
				turnId: TURN,
				stage: 1,
				usage: expect.objectContaining({ promptTokens: 40 }),
			}),
		)
	})
})

describe('the operator’s rules', () => {
	it('reach the classifier’s instructions, with $defaults keeping the built-ins', async () => {
		const { classifier, provider } = build({
			settings: {
				allow: ['$defaults', 'Running our staging deploy script.'],
				environment: ['Our organisation is Acme.'],
			},
		})

		await inTurn(() => classifier.review(request))

		const system = JSON.stringify(provider.requests[0]?.messages)
		expect(system).toContain('Running our staging deploy script.')
		expect(system).toContain('Our organisation is Acme.')
		expect(system).toContain('Local build, test, lint')
	})
})

describe('whether the auto mode can be entered', () => {
	const base = {
		active: MAIN,
		isKnownProvider: (id: string) => KNOWN.has(id),
		hasCredential: (id: string) => id === 'anthropic',
		hasSmallModel: true,
	}

	it('can, with the session’s own model', () => {
		expect(classifierUnavailableReason(base)).toBeUndefined()
	})

	it('cannot when the settings switched it off', () => {
		expect(classifierUnavailableReason({ ...base, disabled: true })).toContain(
			'permissions.disableAutoMode',
		)
	})

	it('cannot when the model it is told to ask has no credential on this machine', () => {
		expect(
			classifierUnavailableReason({ ...base, settings: { model: 'openai/gpt-small' } }),
		).toContain('openai/gpt-small')
		expect(
			classifierUnavailableReason({ ...base, settings: { model: 'anthropic/small' } }),
		).toBeUndefined()
	})

	it('cannot with smallModel and no side model', () => {
		expect(
			classifierUnavailableReason({
				...base,
				hasSmallModel: false,
				settings: { model: SMALL_MODEL_KEYWORD },
			}),
		).toContain('small model')
	})
})

describe('the calls it refused', () => {
	const usage = { promptTokens: 40, completionTokens: 2, totalTokens: 42 }

	it('are kept, newest first, with the call and the reason', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ text: '<verdict>block', usage },
				{
					text: '<verdict>block</verdict><rule>Data sent out</rule><reason>It uploads the file.</reason>',
					usage,
				},
				{ text: '<verdict>allow</verdict>', usage },
			],
		})
		const { classifier } = build({ providerFor: async () => provider })

		await inTurn(() => classifier.review(request))
		await inTurn(() => classifier.review(request))

		expect(classifier.recentBlocks()).toEqual([
			{ tool: 'bash', summary: 'npm test', reason: 'It uploads the file.' },
		])
	})

	it('leave out a check that could not be completed', async () => {
		const { classifier } = build({
			providerFor: async () => {
				throw new Error('no credential')
			},
		})

		await inTurn(() => classifier.review(request))

		expect(classifier.recentBlocks()).toEqual([])
	})
})
