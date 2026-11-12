import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeKey } from './kernel-test-support.js'
import {
	KERNEL_FEED_URL,
	KERNEL_PUBLIC_KEYS,
	feedBase,
	isAllowedFeedUrl,
	parseTestKey,
	trustedKeys,
} from './keys.js'

const test = makeKey('test1')
const testKey = `${test.id}:${test.publicKey}`

describe('which keys the app trusts', () => {
	it('trusts the listed keys, and an injected empty list trusts none', () => {
		expect(KERNEL_PUBLIC_KEYS.map((entry) => entry.id)).toEqual(['k1'])
		expect(trustedKeys({ isPackaged: true, env: {} })).toEqual([...KERNEL_PUBLIC_KEYS])
		expect(trustedKeys({ isPackaged: true, env: {}, compiled: [] })).toEqual([])
		expect(trustedKeys({ isPackaged: false, env: {}, compiled: [] })).toEqual([])
	})

	it('takes one test key from the environment only when the app is not packaged', () => {
		const env = { NAMZU_KERNEL_TEST_PUBLIC_KEY: testKey }
		expect(trustedKeys({ isPackaged: false, env, compiled: [] })).toEqual([
			{ id: 'test1', publicKey: test.publicKey },
		])
		expect(trustedKeys({ isPackaged: true, env, compiled: [] })).toEqual([])
	})

	it('never lets the environment add to a compiled key in a packaged app', () => {
		const compiled = [{ id: 'real', publicKey: makeKey('real').publicKey }]
		expect(
			trustedKeys({ isPackaged: true, env: { NAMZU_KERNEL_TEST_PUBLIC_KEY: testKey }, compiled }),
		).toEqual(compiled)
	})

	it('refuses a test key that is not an id and 32 base64 bytes', () => {
		expect(parseTestKey('nocolon')).toBeUndefined()
		expect(parseTestKey('k1:AAAA')).toBeUndefined()
		expect(parseTestKey(`bad id:${test.publicKey}`)).toBeUndefined()
		expect(parseTestKey(undefined)).toBeUndefined()
		expect(parseTestKey(testKey)).toEqual({ id: 'test1', publicKey: test.publicKey })
	})
})

describe('where the feed is', () => {
	it('is the compiled address, ending with a slash', () => {
		expect(feedBase({ isPackaged: true })).toBe(KERNEL_FEED_URL)
		expect(feedBase({ isPackaged: true, compiled: 'https://x.test/a' })).toBe('https://x.test/a/')
	})

	it('takes any allowed override when unpackaged', () => {
		expect(feedBase({ isPackaged: false, override: 'https://other.test/feed/' })).toBe(
			'https://other.test/feed/',
		)
		expect(feedBase({ isPackaged: false, override: 'http://127.0.0.1:8080/feed' })).toBe(
			'http://127.0.0.1:8080/feed/',
		)
	})

	it('takes only a loopback override when packaged', () => {
		expect(feedBase({ isPackaged: true, override: 'https://other.test/feed/' })).toBe(
			KERNEL_FEED_URL,
		)
		expect(feedBase({ isPackaged: true, override: 'http://127.0.0.1:8080/feed/' })).toBe(
			'http://127.0.0.1:8080/feed/',
		)
		expect(feedBase({ isPackaged: true, override: 'http://localhost:1/feed/' })).toBe(
			'http://localhost:1/feed/',
		)
	})

	it('falls back to the compiled address for an override that is refused', () => {
		for (const override of [
			'http://example.test/feed/',
			'ftp://x/',
			'not a url',
			'https://user:pw@x.test/',
		])
			expect(feedBase({ isPackaged: false, override })).toBe(KERNEL_FEED_URL)
	})

	it('allows https anywhere and http only to this machine, never with credentials', () => {
		expect(isAllowedFeedUrl('https://x.test/a')).toBe(true)
		expect(isAllowedFeedUrl('http://127.0.0.1/a')).toBe(true)
		expect(isAllowedFeedUrl('http://[::1]/a')).toBe(true)
		expect(isAllowedFeedUrl('http://x.test/a')).toBe(false)
		expect(isAllowedFeedUrl('https://u:p@x.test/a')).toBe(false)
		expect(isAllowedFeedUrl('file:///etc/passwd')).toBe(false)
	})
})

describe('the compiled key list and kernel-keys.json', () => {
	const listFile = new URL('../../../kernel-keys.json', import.meta.url)
	const generatedFile = new URL('./keys-compiled.ts', import.meta.url)
	const writeKeys = async () =>
		(await import(
			/* @vite-ignore */ new URL('../../../scripts/kernel/write-keys.mjs', import.meta.url).href
		)) as {
			renderCompiledKeys: (text: string) => string
		}

	it('are the same list: what the app trusts is exactly what the file says (specification 7.8)', () => {
		const fromFile = JSON.parse(readFileSync(listFile, 'utf8')) as {
			id: string
			publicKey: string
		}[]
		expect(KERNEL_PUBLIC_KEYS.map(({ id, publicKey }) => ({ id, publicKey }))).toEqual(fromFile)
	})

	it('are generated from the file: the committed source is what the generator writes for it', async () => {
		const { renderCompiledKeys } = await writeKeys()
		expect(readFileSync(generatedFile, 'utf8')).toBe(
			renderCompiledKeys(readFileSync(listFile, 'utf8')),
		)
	})

	it('cannot be made to differ: a list with keys in it is rendered with every key, in order', async () => {
		const { renderCompiledKeys } = await writeKeys()
		const a = makeKey('k1')
		const b = makeKey('k2')
		const text = renderCompiledKeys(
			JSON.stringify([
				{ id: a.id, publicKey: a.publicKey },
				{ id: b.id, publicKey: b.publicKey },
			]),
		)
		expect(text.indexOf(a.publicKey)).toBeGreaterThan(-1)
		expect(text.indexOf(b.publicKey)).toBeGreaterThan(text.indexOf(a.publicKey))
		expect(() => renderCompiledKeys('{"not":"a list"}')).toThrow()
		expect(() => renderCompiledKeys('[{"id":"k1","publicKey":"short"}]')).toThrow()
	})
})
