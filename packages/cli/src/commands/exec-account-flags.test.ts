import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountRegistry } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { Preferences } from '../integrations/providers/index.js'
import { applyAccountFlag, applyLaunchFlags, applyProviderFlags } from './exec-flags.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function registry() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-exec-account-'))
	dirs.push(dir)
	const reg = createAccountRegistry({ home: dir })
	reg.add({
		provider: 'openrouter',
		label: 'proxy',
		kind: 'api-key',
		apiKey: 'sk-or-local',
		baseUrl: 'http://127.0.0.1:1/v1',
		defaultModel: 'vendor/small',
	})
	reg.add({ provider: 'openai', label: 'work', kind: 'api-key', apiKey: 'sk-local' })
	return reg
}

const bound: Preferences = {
	version: 3,
	providers: [
		{ id: 'openrouter', model: 'vendor/small', account: 'openrouter:proxy' },
		{ id: 'anthropic', model: 'fallback' },
	],
	subagents: { active: [] },
}

describe('--model and --provider keep the account the provider is configured with', () => {
	it('--model alone re-models the primary and keeps its account', () => {
		const next = applyProviderFlags(bound, { provider: null, model: 'vendor/other' })
		expect(next.providers[0]).toEqual({
			id: 'openrouter',
			model: 'vendor/other',
			account: 'openrouter:proxy',
		})
		expect(next.providers[1]).toEqual({ id: 'anthropic', model: 'fallback' })
	})

	it('--provider with a model of that provider keeps its account', () => {
		const next = applyProviderFlags(bound, { provider: 'openrouter', model: 'vendor/other' })
		expect(next.providers).toEqual([
			{ id: 'openrouter', model: 'vendor/other', account: 'openrouter:proxy' },
		])
	})

	it('--provider keeps the account of a fallback member of that provider', () => {
		const prefs: Preferences = {
			...bound,
			providers: [
				{ id: 'anthropic' },
				{ id: 'openrouter', model: 'm', account: 'openrouter:proxy' },
			],
		}
		const next = applyProviderFlags(prefs, { provider: 'openrouter', model: null })
		expect(next.providers).toEqual([{ id: 'openrouter', account: 'openrouter:proxy' }])
	})

	it('leaves a provider with no configured account on its usual sign-in', () => {
		const next = applyProviderFlags(bound, { provider: 'anthropic', model: 'x' })
		expect(next.providers).toEqual([{ id: 'anthropic', model: 'x' }])
	})
})

describe('--account', () => {
	it('binds the named account and its provider', () => {
		const reg = registry()
		const next = applyLaunchFlags(
			{ version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
			{ provider: null, model: null, account: 'proxy' },
			() => reg,
		)
		expect(next).toMatchObject({
			providers: [{ id: 'openrouter', model: 'vendor/small', account: 'openrouter:proxy' }],
		})
	})

	it('takes the model of --model over the account default', () => {
		const next = applyAccountFlag(
			bound,
			{ provider: null, model: 'vendor/big', account: 'openrouter:proxy' },
			registry(),
		)
		expect(next).toHaveProperty('providers.0.model', 'vendor/big')
		expect((next as Preferences).providers[0]).toHaveProperty('account', 'openrouter:proxy')
	})

	it('refuses a name no account has, and a provider the account does not belong to', () => {
		const reg = registry()
		expect(
			applyAccountFlag(bound, { provider: null, model: null, account: 'nope' }, reg),
		).toHaveProperty('error')
		expect(
			applyAccountFlag(bound, { provider: 'anthropic', model: null, account: 'proxy' }, reg),
		).toEqual({
			error:
				'--account proxy belongs to openrouter, not anthropic. Drop --provider or name another account.',
		})
	})

	it('reports an unreadable registry in words', () => {
		const next = applyLaunchFlags(bound, { provider: null, model: null, account: 'x' }, () => {
			throw new Error('disk gone')
		})
		expect(next).toEqual({ error: 'Could not read your accounts: disk gone' })
	})
})
