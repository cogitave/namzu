import { describe, expect, it } from 'vitest'
import type { DetectedProvider } from '../providers/discover.js'
import { createImageAccess } from './image-access.js'

function token(plan?: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
	return `${part({ alg: 'none' })}.${part({
		'https://api.openai.com/auth': {
			[['chatgpt', 'account_id'].join('_')]: 'a',
			...(plan ? { [['chatgpt', 'plan_type'].join('_')]: plan } : {}),
		},
	})}.sig`
}
const codex = (plan?: string, extra: Record<string, unknown> = {}): DetectedProvider =>
	({
		entry: { id: 'codex' },
		source: { kind: 'stored' },
		apiKey: token(plan),
		codex: { accountId: 'a', origin: 'stored' },
		alternatives: [],
		...extra,
	}) as unknown as DetectedProvider
const openai = {
	entry: { id: 'openai' },
	source: { kind: 'env', envName: 'OPENAI_API_KEY' },
	apiKey: 'sk-test',
	alternatives: [],
} as unknown as DetectedProvider
const deps = (list: DetectedProvider[]) => ({
	detected: () => list,
	primaryId: 'deepseek',
	prepare: async () => undefined,
})

describe('image access', () => {
	it('is available for a paid plan or an unreadable one, whatever model leads', () => {
		for (const plan of ['plus', 'pro', 'team', 'go', undefined])
			expect(createImageAccess(deps([codex(plan)])).available(), String(plan)).toBe(true)
	})
	it('is not available on the Free plan, with no sign-in, or with an API key alone', () => {
		expect(createImageAccess(deps([codex('free')])).available()).toBe(false)
		expect(createImageAccess(deps([])).available()).toBe(false)
		expect(createImageAccess(deps([openai])).available()).toBe(false)
	})
	it('uses the leading provider own renewed sign-in when that is the ChatGPT one', async () => {
		const access = createImageAccess({
			detected: () => [codex('plus')],
			primaryId: 'codex',
			prepare: async () => ({ accessToken: 'fresh', accountId: 'a' }),
		})
		await expect(access.read(new AbortController().signal)).resolves.toEqual({
			accessToken: 'fresh',
			accountId: 'a',
		})
	})
	it('reads nothing when no sign-in is connected', async () => {
		await expect(
			createImageAccess(deps([openai])).read(new AbortController().signal),
		).resolves.toBeUndefined()
	})
})
