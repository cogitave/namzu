import type { Account } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	ADD_ACCOUNT_VALUE,
	type AccountWizard,
	accountProblem,
	advanceWizard,
	buildAccountPicker,
	promptFor,
	startApiKeyWizard,
	suggestLabel,
	validateLabel,
	wizardProvider,
} from './account-flow.js'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const account = (provider: string, label: string, extra: Partial<Account> = {}): Account => ({
	id: `${provider}:${label}`,
	provider,
	label,
	source: label === 'default' ? { kind: 'existing-default' } : { kind: 'api-key', keyRef: 'k' },
	createdAt: '',
	...extra,
})
const empty = { lastUsed: {}, limitedUntil: {}, autoSwitch: {} }

describe('the account picker', () => {
	const base = {
		accounts: [
			account('codex', 'default'),
			account('openai', 'default'),
			account('openai', 'free-a', { baseUrl: 'https://api.example.test/v1' }),
			account('openai', 'free-b'),
		],
		activity: { ...empty, lastUsed: { 'openai:free-b': 50, 'openai:free-a': 40 } },
		currentId: 'openai:free-a',
		now: NOW,
		signedIn: () => true,
		hasUsualSignIn: (provider: string) => provider === 'codex',
		locale: 'en-US',
	}

	it('lists last used first, marks the current one, hides a usual sign-in that is not there, ends with Add', () => {
		const model = buildAccountPicker(base)
		expect(model.values).toEqual([
			'openai:free-b',
			'openai:free-a',
			'codex:default',
			ADD_ACCOUNT_VALUE,
		])
		expect(model.options.map((o) => o.label)).toEqual([
			'OpenAI · free-b',
			'OpenAI · free-a',
			'Codex · default',
			'Add an account…',
		])
		expect(model.options.map((o) => o.current === true)).toEqual([false, true, false, false])
		expect(model.options[1]?.description).toBe('ready · api.example.test')
		expect(model.options.at(-1)?.ruleBefore).toBe(true)
		expect(model.notice).toContain('other conversations are unaffected')
	})

	it('says limited until a time and needs sign-in, and filters by provider, label or host', () => {
		const model = buildAccountPicker({
			...base,
			activity: { ...base.activity, limitedUntil: { 'openai:free-a': NOW + 3_600_000 } },
			signedIn: (a) => a.label !== 'free-b',
		})
		expect(model.options[1]?.description).toMatch(/^limited until \d{1,2}:\d{2}/)
		expect(model.options[0]?.description).toBe('needs sign-in')
		expect(model.options[1]?.searchText).toContain('api.example.test')
		expect(model.options[0]?.searchText).toContain('openai')
	})

	it('is worded for a spent allowance when opened by one, with no ids on screen', () => {
		const model = buildAccountPicker({ ...base, limitedLabel: 'OpenAI · free-a' })
		expect(model.title).toBe('OpenAI · free-a has used up its allowance')
		expect(model.notice).toBe('Choose another account to continue this reply.')
		for (const option of model.options)
			expect(option.label + option.description).not.toMatch(/:default|keyRef/)
	})

	it('shows an account that switches by itself', () => {
		const model = buildAccountPicker({
			...base,
			activity: { ...base.activity, autoSwitch: { 'openai:free-a': true } },
		})
		expect(model.options[1]?.description).toContain('switches automatically')
	})
})

describe('adding an account', () => {
	it('walks an API key through address, key (masked), name and model, then adds it', () => {
		let wizard: AccountWizard = startApiKeyWizard('openai')
		expect(promptFor(wizard, []).allowEmpty).toBe(true)
		let step = advanceWizard(wizard, 'https://api.example.test/v1', [])
		if (step.kind !== 'next') throw new Error('expected next')
		wizard = step.wizard
		expect(promptFor(wizard, []).mask).toBe(true)
		step = advanceWizard(wizard, '  sk-test  ', [])
		if (step.kind !== 'next') throw new Error('expected next')
		wizard = step.wizard
		expect(promptFor(wizard, ['openai-2'])).toMatchObject({ initialValue: 'openai' })
		step = advanceWizard(wizard, 'free-a', [])
		if (step.kind !== 'next') throw new Error('expected next')
		wizard = step.wizard
		expect(promptFor(wizard, []).allowEmpty).toBe(true)
		expect(advanceWizard(wizard, 'glm-5.3-flash-uncensored', [])).toEqual({
			kind: 'add-key',
			provider: 'openai',
			key: 'sk-test',
			label: 'free-a',
			baseUrl: 'https://api.example.test/v1',
			defaultModel: 'glm-5.3-flash-uncensored',
		})
		expect(advanceWizard(wizard, '', [])).toMatchObject({ kind: 'add-key' })
		expect(
			(advanceWizard(wizard, '', []) as { defaultModel?: string }).defaultModel,
		).toBeUndefined()
	})

	it('skips the address when left empty, and refuses a bad one, an empty key, a bad or taken name', () => {
		const wizard = startApiKeyWizard('deepseek') as Extract<AccountWizard, { kind: 'api-key' }>
		expect(advanceWizard(wizard, '', [])).toMatchObject({
			kind: 'next',
			wizard: { step: 'key' },
		})
		for (const bad of ['not a url', 'ftp://x.test', 'https://user:pw@x.test']) {
			expect(advanceWizard(wizard, bad, []).kind).toBe('retry')
		}
		expect(advanceWizard({ ...wizard, step: 'key' }, '   ', []).kind).toBe('retry')
		const labelStep = { ...wizard, step: 'label' } as AccountWizard
		expect(advanceWizard(labelStep, 'Work Account', [])).toMatchObject({ kind: 'retry' })
		expect(advanceWizard(labelStep, 'default', [])).toMatchObject({ kind: 'retry' })
		expect(advanceWizard(labelStep, 'taken', ['taken'])).toMatchObject({
			kind: 'retry',
			notice: 'There is already an account called "taken".',
		})
		const modelStep = { ...wizard, step: 'model', key: 'k', label: 'x' } as AccountWizard
		expect(advanceWizard(modelStep, 'two words', []).kind).toBe('retry')
	})

	it('names a Codex account and a rename with the same rules, and suggests free names', () => {
		expect(advanceWizard({ kind: 'codex' }, 'work', [])).toEqual({
			kind: 'sign-in-codex',
			label: 'work',
		})
		expect(advanceWizard({ kind: 'codex' }, 'work', ['work']).kind).toBe('retry')
		expect(advanceWizard({ kind: 'rename', id: 'codex:a' }, 'b', [])).toEqual({
			kind: 'rename',
			id: 'codex:a',
			label: 'b',
		})
		expect(suggestLabel('codex', [])).toBe('codex')
		expect(suggestLabel('codex', ['codex', 'codex-2'])).toBe('codex-3')
		expect(suggestLabel('Open AI!', [])).toBe('open-ai-')
		expect(validateLabel('ok-1', [])).toBeUndefined()
		expect(wizardProvider({ kind: 'rename', id: 'codex:a' })).toBe('codex')
		expect(wizardProvider(startApiKeyWizard('zen'))).toBe('zen')
	})

	it('shows a registry refusal as its own sentence and anything else as the fallback', () => {
		expect(accountProblem(new Error('ENOENT /secret/path'), 'Could not add the account.')).toBe(
			'Could not add the account.',
		)
	})
})
