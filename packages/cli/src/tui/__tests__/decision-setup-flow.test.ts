import { describe, expect, it } from 'vitest'

import type { SetupDraft } from '../../integrations/decision/setup.js'
import {
	DECISION_KIND_OPTIONS,
	DECISION_KIND_VALUES,
	advanceDecisionFlow,
	decisionPrompt,
	startOpenRouter,
} from '../decision-setup-flow.js'

const KEY = '4f1c9a0b7d3e48a2b6c5d8e9f0a1b2c3'

describe('the Azure path', () => {
	const start: SetupDraft = { kind: 'azure' }

	it('takes a whole paste in one step and looks for the deployment', () => {
		const next = advanceDecisionFlow(
			start,
			'azure-paste',
			`KEY 1 ${KEY} Endpoint https://r.services.ai.azure.com/`,
		)
		expect(next).toEqual({
			kind: 'list-deployments',
			draft: { kind: 'azure', endpoint: 'https://r.services.ai.azure.com', key: KEY },
		})
	})

	it('is done when the paste carries the deployment too', () => {
		const next = advanceDecisionFlow(
			start,
			'azure-paste',
			`https://r.cognitiveservices.azure.com/openai/deployments/dep/chat/completions key: ${KEY}`,
		)
		expect(next.kind).toBe('done')
	})

	it('asks for the endpoint when only a key was pasted, then for the key when only an endpoint was', () => {
		expect(advanceDecisionFlow(start, 'azure-paste', KEY)).toMatchObject({
			kind: 'ask',
			step: 'azure-endpoint',
		})
		expect(
			advanceDecisionFlow(start, 'azure-paste', 'https://r.services.ai.azure.com'),
		).toMatchObject({
			kind: 'ask',
			step: 'azure-key',
		})
	})

	it('treats an empty key as the Azure sign-in and asks for the deployment itself', () => {
		const draft: SetupDraft = { kind: 'azure', endpoint: 'https://r.services.ai.azure.com' }
		expect(advanceDecisionFlow(draft, 'azure-key', '')).toMatchObject({
			kind: 'ask',
			step: 'azure-deployment',
			draft: { key: '' },
		})
	})

	it('asks again, with a reason, for text that holds nothing', () => {
		expect(advanceDecisionFlow(start, 'azure-paste', 'just some words')).toMatchObject({
			kind: 'retry',
			step: 'azure-paste',
		})
		expect(advanceDecisionFlow(start, 'azure-endpoint', 'https://example.com')).toMatchObject({
			kind: 'retry',
		})
	})

	it('finishes once the deployment is typed', () => {
		const draft: SetupDraft = {
			kind: 'azure',
			endpoint: 'https://r.services.ai.azure.com',
			key: KEY,
		}
		expect(advanceDecisionFlow(draft, 'azure-deployment', ' dep ')).toEqual({
			kind: 'done',
			draft: { ...draft, deployment: 'dep' },
		})
	})
})

describe('the own-server path', () => {
	it('takes the address, an optional key and an optional model', () => {
		const a = advanceDecisionFlow({ kind: 'http' }, 'http-url', 'http://127.0.0.1:8080/decide')
		expect(a).toMatchObject({ kind: 'ask', step: 'http-key' })
		const b = advanceDecisionFlow((a as { draft: SetupDraft }).draft, 'http-key', '')
		expect(b).toMatchObject({ kind: 'ask', step: 'http-model' })
		expect((b as { draft: SetupDraft }).draft).not.toHaveProperty('key')
		const c = advanceDecisionFlow((b as { draft: SetupDraft }).draft, 'http-model', 'm1')
		expect(c).toEqual({
			kind: 'done',
			draft: { kind: 'http', url: 'http://127.0.0.1:8080/decide', model: 'm1' },
		})
	})

	it('refuses an address that is not http or https', () => {
		expect(advanceDecisionFlow({ kind: 'http' }, 'http-url', 'nope')).toMatchObject({
			kind: 'retry',
		})
		expect(advanceDecisionFlow({ kind: 'http' }, 'http-url', 'ftp://h/x')).toMatchObject({
			kind: 'retry',
		})
	})
})

describe('a key over plain http', () => {
	it('is refused for any host but this machine', () => {
		for (const url of [
			'http://example.com/x',
			'http://10.0.0.5:8080/d',
			'http://localhost.evil.net/d',
		]) {
			expect(advanceDecisionFlow({ kind: 'http' }, 'http-url', url)).toMatchObject({
				kind: 'retry',
			})
		}
	})

	it('is allowed to this machine, and over https anywhere', () => {
		for (const url of [
			'http://localhost:1/d',
			'http://127.0.0.1/d',
			'http://[::1]:2/d',
			'http://a.localhost/d',
			'https://example.com/d',
		]) {
			expect(advanceDecisionFlow({ kind: 'http' }, 'http-url', url)).toMatchObject({
				kind: 'ask',
				step: 'http-key',
			})
		}
	})
})

describe('the fields', () => {
	it('mask what can hold a key, and let the optional ones stay empty', () => {
		expect(decisionPrompt('azure-paste').mask).toBe(true)
		expect(decisionPrompt('http-key')).toMatchObject({ mask: true, allowEmpty: true })
		expect(decisionPrompt('http-url').mask).toBeUndefined()
	})

	it('names the deployments found and starts on the first', () => {
		expect(decisionPrompt('azure-deployment', { deployments: ['a', 'b'] })).toMatchObject({
			title: 'Deployment (found: a, b)',
			initialValue: 'a',
		})
	})
})

describe('the OpenRouter path', () => {
	it('is the first choice, then Azure, then the own server', () => {
		expect(DECISION_KIND_VALUES).toEqual(['openrouter', 'azure', 'http'])
		expect(DECISION_KIND_OPTIONS.map((o) => o.label)).toEqual([
			'OpenRouter',
			'Azure AI Foundry',
			'My own server (HTTP)',
		])
	})

	it('reuses a key from the environment or the store without asking', () => {
		expect(startOpenRouter({ source: 'env', env: 'OPENROUTER_API_KEY' })).toEqual({
			kind: 'list-models',
			draft: { kind: 'openrouter', keyEnv: 'OPENROUTER_API_KEY' },
		})
		expect(startOpenRouter({ source: 'store', key: 'k-1' })).toEqual({
			kind: 'list-models',
			draft: { kind: 'openrouter', key: 'k-1' },
		})
	})

	it('asks for a masked key when there is none, then lists the models', () => {
		const ask = startOpenRouter(undefined)
		expect(ask).toMatchObject({ kind: 'ask', step: 'openrouter-key' })
		expect(decisionPrompt('openrouter-key').mask).toBe(true)
		expect(advanceDecisionFlow({ kind: 'openrouter' }, 'openrouter-key', ' sk-x ')).toEqual({
			kind: 'list-models',
			draft: { kind: 'openrouter', key: 'sk-x' },
		})
		expect(advanceDecisionFlow({ kind: 'openrouter' }, 'openrouter-key', ' ')).toMatchObject({
			kind: 'retry',
		})
	})

	it('offers the two fallbacks as a typed step starting on the default when the list fails', () => {
		const spec = decisionPrompt('openrouter-model')
		expect(spec.initialValue).toBe('microsoft/microsoft-decision-1')
		expect(spec.placeholder).toContain('typesafe/jev-1.14')
		expect(
			advanceDecisionFlow({ kind: 'openrouter' }, 'openrouter-model', 'typesafe/jev-1.14'),
		).toEqual({
			kind: 'done',
			draft: { kind: 'openrouter', model: 'typesafe/jev-1.14' },
		})
	})
})

it('rejects a typed OpenRouter model id that is not an id', () => {
	for (const bad of ['has space', 'x'.repeat(129), 'a\u001b[2J', 'a"b']) {
		expect(advanceDecisionFlow({ kind: 'openrouter' }, 'openrouter-model', bad).kind).toBe('retry')
	}
})
