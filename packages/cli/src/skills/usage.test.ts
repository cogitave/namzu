import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
	TOKEN_WINDOW_MS,
	USE_THROTTLE_MS,
	ageWord,
	readSkillUsage,
	recordSkillUse,
	sevenDayTokens,
	skillUsagePath,
	usageWords,
} from './usage.js'

const NOW = Date.parse('2026-06-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const home = () => mkdtempSync(join(tmpdir(), 'skill-usage-'))

describe('the usage record', () => {
	it('starts empty and counts a first load', () => {
		const dir = home()
		expect(readSkillUsage(dir, NOW)).toEqual({ since: NOW, skills: {} })
		expect(recordSkillUse('alpha', 400, { home: dir, now: NOW })).toBe(true)
		const usage = readSkillUsage(dir, NOW)
		expect(usage.since).toBe(NOW)
		expect(usage.skills.alpha).toEqual({
			count: 1,
			lastUsedAt: NOW,
			loads: [{ at: NOW, tokens: 100 }],
		})
	})

	it('counts loads within a minute once, and later ones again', () => {
		const dir = home()
		recordSkillUse('alpha', 400, { home: dir, now: NOW })
		expect(recordSkillUse('alpha', 400, { home: dir, now: NOW + USE_THROTTLE_MS - 1 })).toBe(false)
		expect(recordSkillUse('alpha', 800, { home: dir, now: NOW + USE_THROTTLE_MS })).toBe(true)
		const use = readSkillUsage(dir, NOW).skills.alpha
		expect(use?.count).toBe(2)
		expect(use?.loads.map((load) => load.tokens)).toEqual([100, 200])
	})

	it('forgets a load once it is older than seven days', () => {
		const dir = home()
		recordSkillUse('alpha', 400, { home: dir, now: NOW })
		recordSkillUse('alpha', 400, { home: dir, now: NOW + TOKEN_WINDOW_MS + DAY })
		const use = readSkillUsage(dir, NOW).skills.alpha
		expect(use?.count).toBe(2)
		expect(use?.loads).toHaveLength(1)
	})

	it('reads a file that is not its own as empty and never throws on write', () => {
		const dir = home()
		writeFileSync(skillUsagePath(dir), 'not json')
		expect(readSkillUsage(dir, NOW).skills).toEqual({})
		expect(recordSkillUse('alpha', 40, { home: dir, now: NOW })).toBe(true)
		expect(JSON.parse(readFileSync(skillUsagePath(dir), 'utf8')).v).toBe(1)
		// A home that cannot be written to costs nothing.
		expect(recordSkillUse('alpha', 40, { home: join(skillUsagePath(dir), 'x'), now: NOW })).toBe(
			false,
		)
	})
})

describe('how it reads', () => {
	const use = { count: 3, lastUsedAt: NOW - 2 * DAY, loads: [{ at: NOW - 2 * DAY, tokens: 50 }] }

	it('says today, days and never', () => {
		expect(ageWord(undefined, NOW)).toBe('never')
		expect(ageWord({ ...use, lastUsedAt: NOW - 1000 }, NOW)).toBe('today')
		expect(ageWord(use, NOW)).toBe('2d')
		expect(usageWords(use, NOW)).toBe('3× 2d')
		expect(usageWords(undefined, NOW)).toBe('never used')
	})

	it('sums the last seven days and has no figure when there is none', () => {
		expect(sevenDayTokens(use, NOW)).toBe(50)
		expect(sevenDayTokens(use, NOW + 10 * DAY)).toBeUndefined()
		expect(sevenDayTokens(undefined, NOW)).toBeUndefined()
	})
})
