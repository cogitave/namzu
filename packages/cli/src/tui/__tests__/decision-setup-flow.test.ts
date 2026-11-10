import { describe, expect, it } from 'vitest'

import type { SetupDraft } from '../../integrations/decision/setup.js'
import { advanceDecisionFlow, decisionPrompt } from '../decision-setup-flow.js'

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
