import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import {
	TERMS,
	displayPath,
	formatSize,
	formatSpan,
	homePath,
	localEndpoint,
	plural,
	productName,
	shortId,
} from './person-terms.js'

describe('the glossary and humanisers', () => {
	it('names concepts once, in the person’s words', () => {
		expect(TERMS.reply).toBe('reply')
		expect(TERMS.conversation).toBe('conversation')
		expect(TERMS.summarising).toBe('summarising the conversation')
		expect(Object.values(TERMS).join(' ')).not.toMatch(
			/\b(turn|session|checkpoint|compaction|host)\b/,
		)
	})

	it('pluralises correctly and groups digits', () => {
		expect(plural(1, 'message')).toBe('1 message')
		expect(plural(2, 'message')).toBe('2 messages')
		expect(plural(1, 'match', 'matches')).toBe('1 match')
		expect(plural(12400, 'token')).toBe('12,400 tokens')
	})

	it('shows spans and sizes without milliseconds or raw bytes', () => {
		expect(formatSpan(250)).toBe('1s')
		expect(formatSpan(20_000)).toBe('20s')
		expect(formatSpan(65_000)).toBe('1m 05s')
		expect(formatSpan(120_000)).toBe('2m 00s')
		expect(formatSize(512)).toBe('512 B')
		expect(formatSize(48_213)).toBe('47 KB')
		expect(formatSize(7_680)).toBe('7.5 KB')
		expect(formatSize(1_048_576)).toBe('1 MB')
		expect(formatSize(1_258_291)).toBe('1.2 MB')
	})

	it('uses product names and short paths', () => {
		expect(productName('openai')).toBe('OpenAI')
		expect(productName('codex')).toBe('OpenAI')
		expect(productName('anthropic')).toBe('Anthropic')
		expect(productName('nopeai')).toBeUndefined()
		expect(productName(undefined)).toBeUndefined()
		expect(homePath('/home/ada/work/app', '/home/ada')).toBe('~/work/app')
		expect(homePath('/srv/app', '/home/ada')).toBe('/srv/app')
		expect(shortId('01a12552-fe6b-733f-bdfd-ee9abb0b6021')).toBe('01a12552')
	})
})

describe('displayPath', () => {
	const home = '/home/arda'
	const deep = '/home/arda/workspaces/@cogitave/cogitave/namzu/packages/cli'
	it('writes home as ~ and keeps a short path whole', () => {
		expect(displayPath('/home/arda/work', 40, home)).toBe('~/work')
	})
	it('cuts the middle, keeping ~ and the last folders whole', () => {
		expect(displayPath(deep, 32, home)).toBe('~/…/cogitave/namzu/packages/cli')
	})
	for (const width of [34, 54, 74]) {
		it(`fits ${width} cells and never splits the last folder`, () => {
			const shown = displayPath(deep, width, home)
			expect(shown.length).toBeLessThanOrEqual(width)
			expect(shown.endsWith('/cli')).toBe(true)
		})
	}
	it('drops the head before cutting the leaf', () => {
		expect(displayPath(deep, 6, home)).toBe('…/cli')
	})
	it('cuts a leaf wider than the room from its start', () => {
		const shown = displayPath('/home/arda/a-very-long-folder-name', 8, home)
		expect(shown).toBe('…lder-name'.slice(0, 1) + 'er-name')
	})
	it('handles Windows paths', () => {
		expect(displayPath('C:\\Users\\arda\\work\\namzu\\packages\\cli', 20, 'D:\\none')).toBe(
			'C:\\…\\packages\\cli',
		)
	})
})

describe('displayPath measures display cells', () => {
	const home = '/home/arda'
	it('counts a CJK folder name as two cells a character', () => {
		const path = '/home/arda/プロジェクト/日本語のフォルダ/最後'
		for (const width of [10, 16, 24, 30]) {
			const shown = displayPath(path, width, home)
			expect(stringWidth(shown)).toBeLessThanOrEqual(width)
			expect(shown.endsWith('最後')).toBe(true)
		}
	})
	it('counts an emoji as two cells', () => {
		const path = '/home/arda/🚀/launch-pad/🛰️-station'
		for (const width of [12, 18, 24]) {
			expect(stringWidth(displayPath(path, width, home))).toBeLessThanOrEqual(width)
		}
		expect(displayPath('/home/arda/🚀🚀🚀', 5, home)).toBe('…🚀🚀')
	})
	it('cuts a wide leaf on a character boundary', () => {
		const shown = displayPath('/home/arda/日本語日本語日本語', 8, home)
		expect(stringWidth(shown)).toBeLessThanOrEqual(8)
		expect(shown.startsWith('…')).toBe(true)
		expect(shown).not.toContain('\uFFFD')
	})
})

describe('localEndpoint', () => {
	it('knows the local servers from the provider list', () => {
		expect(localEndpoint('ollama')).toBe('localhost:11434')
		expect(localEndpoint('lmstudio')).toBe('localhost:1234')
	})
	it.each([
		['http://127.0.0.1:8080/v1', '127.0.0.1:8080'],
		['http://[::1]:9000', '[::1]:9000'],
		['http://192.168.1.20:11434', '192.168.1.20:11434'],
		['http://10.0.0.5', '10.0.0.5'],
		['http://172.20.0.2:8000', '172.20.0.2:8000'],
		['http://my-box.local:1234', 'my-box.local:1234'],
		['http://gpu-box:11434', 'gpu-box:11434'],
		['http://100.101.1.2:8080', '100.101.1.2:8080'],
		['http://localhost.:81', 'localhost:81'],
	])('treats %s as local', (url, shown) => {
		expect(localEndpoint('openai', url)).toBe(shown)
	})
	it.each(['https://api.openai.com/v1', 'http://172.32.0.1', 'http://8.8.8.8'])(
		'treats %s as the internet',
		(url) => {
			expect(localEndpoint('openai', url)).toBeUndefined()
		},
	)
	it('is not local for a hosted provider without a base URL', () => {
		expect(localEndpoint('openai')).toBeUndefined()
		expect(localEndpoint(undefined)).toBeUndefined()
	})
})
