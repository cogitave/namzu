import { describe, expect, it } from 'vitest'

import {
	TERMS,
	formatSize,
	formatSpan,
	homePath,
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
		expect(productName('nopeai')).toBe('Nopeai')
		expect(productName(undefined)).toBeUndefined()
		expect(homePath('/home/ada/work/app', '/home/ada')).toBe('~/work/app')
		expect(homePath('/srv/app', '/home/ada')).toBe('/srv/app')
		expect(shortId('01a12552-fe6b-733f-bdfd-ee9abb0b6021')).toBe('01a12552')
	})
})
