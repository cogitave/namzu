import { describe, expect, it } from 'vitest'
import { normalizeAzureEndpoint, parseAzurePaste } from '../paste.js'

const KEY1 = '4f1c9a0b7d3e48a2b6c5d8e9f0a1b2c3'
const KEY2 = '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b'

describe('parseAzurePaste', () => {
	it('reads the Keys and Endpoint page copied line by line', () => {
		const text = `KEY 1\n${KEY1}\nKEY 2\n${KEY2}\nLocation/Region\neastus\nEndpoint\nhttps://my-res.cognitiveservices.azure.com/\n`
		expect(parseAzurePaste(text)).toEqual({
			endpoint: 'https://my-res.cognitiveservices.azure.com',
			key: KEY1,
		})
	})

	it('reads the same page after the one-line field folded it into spaces', () => {
		const text = `KEY 1 ${KEY1} KEY 2 ${KEY2} Location/Region eastus Endpoint https://my-res.services.ai.azure.com/`
		expect(parseAzurePaste(text)).toEqual({
			endpoint: 'https://my-res.services.ai.azure.com',
			key: KEY1,
		})
	})

	it('prefers key 1 even when key 2 comes first', () => {
		expect(parseAzurePaste(`Key2: ${KEY2}\nKey1: ${KEY1}`).key).toBe(KEY1)
	})

	it('reads label: value and label=value forms, and the deployment', () => {
		const text = `AZURE_FOUNDRY_ENDPOINT=https://r.services.ai.azure.com\napi-key: ${KEY1}\nDeployment name: decider-1`
		expect(parseAzurePaste(text)).toEqual({
			endpoint: 'https://r.services.ai.azure.com',
			key: KEY1,
			deployment: 'decider-1',
		})
	})

	it('takes the deployment out of a target URI and drops its path and query', () => {
		const text = `Target URI https://r.cognitiveservices.azure.com/openai/deployments/gpt-x/chat/completions?api-version=2024-02-01 Key ${KEY1}`
		expect(parseAzurePaste(text)).toEqual({
			endpoint: 'https://r.cognitiveservices.azure.com',
			key: KEY1,
			deployment: 'gpt-x',
		})
	})

	it('reads a key pasted alone, and an endpoint pasted alone', () => {
		expect(parseAzurePaste(KEY1)).toEqual({ key: KEY1 })
		expect(parseAzurePaste('https://A-B.services.ai.azure.com/anything')).toEqual({
			endpoint: 'https://a-b.services.ai.azure.com',
		})
	})

	it('keeps base64 padding on a key', () => {
		const key = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQrStUvWx=='
		expect(parseAzurePaste(`key: ${key}`).key).toBe(key)
	})

	it('finds nothing in junk or in an endpoint of another host', () => {
		expect(parseAzurePaste('hello there, this is not a credential')).toEqual({})
		expect(parseAzurePaste('')).toEqual({})
		expect(parseAzurePaste('https://example.com/x https://evil.azure.com.attacker.io')).toEqual({})
	})

	it('does not take a word of the page for a key', () => {
		expect(
			parseAzurePaste('Endpoint https://r.services.ai.azure.com Location/Region eastus'),
		).toEqual({
			endpoint: 'https://r.services.ai.azure.com',
		})
	})
})

describe('normalizeAzureEndpoint', () => {
	it('accepts the two resource hosts only', () => {
		expect(normalizeAzureEndpoint('https://x.services.ai.azure.com/')).toBe(
			'https://x.services.ai.azure.com',
		)
		expect(normalizeAzureEndpoint('http://x.services.ai.azure.com')).toBeUndefined()
		expect(normalizeAzureEndpoint('https://x.openai.azure.com')).toBeUndefined()
	})
})

describe('what is not an endpoint or a key', () => {
	it('refuses a longer host that only starts like an Azure one', () => {
		expect(normalizeAzureEndpoint('https://x.services.ai.azure.com.evil.net/path')).toBeUndefined()
		expect(
			normalizeAzureEndpoint('https://evil.net/?r=https://x.services.ai.azure.com'),
		).toBeUndefined()
	})

	it('still reads an endpoint in quotes, after a label, or ending a sentence', () => {
		expect(normalizeAzureEndpoint('"https://x.services.ai.azure.com"')).toBe(
			'https://x.services.ai.azure.com',
		)
		expect(normalizeAzureEndpoint('endpoint=https://x.services.ai.azure.com/')).toBe(
			'https://x.services.ai.azure.com',
		)
		expect(normalizeAzureEndpoint('Use https://x.services.ai.azure.com.')).toBe(
			'https://x.services.ai.azure.com',
		)
	})

	it('does not take a deployment name for a key', () => {
		expect(parseAzurePaste('gpt-4o-mini-decision-01').key).toBeUndefined()
		expect(
			parseAzurePaste('https://x.services.ai.azure.com gpt4omini0decision01abc').key,
		).toBeUndefined()
	})

	it('still takes a key pasted alone', () => {
		expect(parseAzurePaste(KEY1).key).toBe(KEY1)
	})
})
