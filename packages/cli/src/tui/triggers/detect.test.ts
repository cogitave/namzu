/**
 * Detection, table-driven. Every case the adversarial review found is here
 * with the result it SHOULD have (the review's probe recorded what the first
 * draft did instead), plus the checked-in corpora, the placement rules, the
 * provenance and Alt+W states, availability, and a bound on the matcher's
 * work counted in steps rather than time.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	MAX_SCANNED_DRAFT,
	type TriggerContext,
	type TriggerState,
	detectTriggers,
} from './detect.js'
import type { MatchStats } from './pattern.js'
import { type TriggerId, compileRegistry } from './registry.js'

const CONTEXT: TriggerContext = {
	permissionMode: 'prompt',
	sessionHypermode: false,
	effortMenu: true,
	agentTool: true,
	skillCreator: true,
	scheduleTool: true,
}
const REGISTRY = compileRegistry()
/** Every built-in on: `max-effort` ships off, and its phrases are tested too. */
const ALL_ON = compileRegistry(undefined, { arming: { 'max-effort': 'arm' } })

function stateOf(text: string, id: TriggerId, registry = REGISTRY): TriggerState | 'none' {
	return detectTriggers(text, registry, CONTEXT).hits.find((hit) => hit.id === id)?.state ?? 'none'
}

describe('the review cases, with the result they should have', () => {
	it.each([
		// The owner's own sentence, with the keyword in the middle: talk.
		[
			"yani mesela claude'da hypermode yazınca farklı bir şekilde gözüküyor",
			'hypermode',
			'suggested',
		],
		['how does the hypermode keyword work?', 'hypermode', 'suggested'],
		['what is hypermode?', 'hypermode', 'suggested'],
		['hypermode fix the flaky test', 'hypermode', 'armed'],
		['fix the flaky test, hypermode', 'hypermode', 'armed'],
		["hypermode'u nasıl açarım", 'hypermode', 'none'],
		['how do I fix this and save it as a skill?', 'save-skill', 'suggested'],
		['skill olarak kaydet: bu komut ne yapıyor?', 'save-skill', 'suggested'],
		['bunu skill olarak kaydedelim mi', 'save-skill', 'armed'],
		['bunu skill olarak kaydedebilir misin', 'save-skill', 'armed'],
		['bunu skill olarak kaydetsene', 'save-skill', 'armed'],
		['bunu skill olarak kaydedermisin', 'save-skill', 'armed'],
		['kaydet bunu skill olarak', 'save-skill', 'suggested'],
		['bunu skille çevir', 'save-skill', 'suggested'],
		['testleri düzelt, sonra bunu skill olarak kaydet', 'save-skill', 'armed'],
		// `schedule` never arms from text, however plainly it is asked for.
		['write a backup script and schedule it', 'schedule', 'suggested'],
		['add the cron entry, then run it every day', 'schedule', 'suggested'],
		['schedule it', 'schedule', 'suggested'],
		['re-save it as a skill template', 'save-skill', 'suggested'],
		['  !echo hypermode', 'hypermode', 'none'],
		['  /skills save', 'save-skill', 'none'],
		['#hypermode note', 'hypermode', 'none'],
	] as const)('%s → %s %s', (text, id, expected) => {
		expect(stateOf(text, id)).toBe(expected)
	})

	it('never arms on the other agent keyword', () => {
		for (const text of ['ultracode fix the flaky test', 'fix it, ultracode', 'ultracode']) {
			expect(detectTriggers(text, REGISTRY, CONTEXT).hits).toEqual([])
		}
	})

	it('does not split a word at an inner hyphen', () => {
		// `sub-agents` is one clause edge-free run: the phrase still matches whole.
		expect(stateOf('delegate this to sub-agents', 'hypermode')).toBe('armed')
		expect(stateOf('e-posta gönder, hypermode', 'hypermode')).toBe('armed')
		// The hyphen opens no clause, so this keyword stands mid-clause.
		expect(stateOf('pre-hypermode checks', 'hypermode')).toBe('suggested')
	})

	it('excludes everything after an unclosed quote or backtick', () => {
		expect(stateOf('"hypermode fix the flaky test', 'hypermode')).toBe('none')
		expect(stateOf('fix `this, hypermode', 'hypermode')).toBe('none')
		expect(stateOf('say “bunu skill olarak kaydet', 'save-skill')).toBe('none')
	})
})

describe('the owner scenarios', () => {
	it('arms hypermode on the Turkish request and highlights only the keyword', () => {
		const text = "hypermode ile şu repodaki TODO'ları iki agent'a bölerek say"
		const hit = detectTriggers(text, REGISTRY, CONTEXT).hits.find((h) => h.id === 'hypermode')
		expect(hit?.state).toBe('armed')
		expect(text.slice(hit?.start, hit?.end)).toBe('hypermode')
	})

	it('arms save-as-skill on the Turkish phrase, and knows a message that is only the phrase', () => {
		const alone = detectTriggers('bunu skill olarak kaydet', REGISTRY, CONTEXT)
		expect(alone.hits.map((hit) => [hit.id, hit.state])).toEqual([['save-skill', 'armed']])
		expect(alone.onlyTriggers).toBe(true)
		const embedded = detectTriggers(
			"şu repodaki TODO'ları say ve bunu skill olarak kaydet",
			REGISTRY,
			CONTEXT,
		)
		expect(embedded.hits.map((hit) => [hit.id, hit.state])).toEqual([['save-skill', 'armed']])
		expect(embedded.onlyTriggers).toBe(false)
		const hit = embedded.hits[0]
		expect(
			"şu repodaki TODO'ları say ve bunu skill olarak kaydet".slice(hit?.start, hit?.end),
		).toBe('bunu skill olarak kaydet')
	})
})

describe('placement', () => {
	it.each([
		['hypermode', 'armed'],
		['hypermode: audit every endpoint', 'armed'],
		['hypermode, can you split this?', 'armed'],
		['hypermode ile bunu iki parçaya bölüp yapar mısın?', 'armed'],
		['HYPERMODE fix it', 'armed'],
		['fix this and hypermode', 'armed'],
		['fix it (hypermode)', 'armed'],
		['fix the tests - hypermode', 'armed'],
		['hypermode nedir?', 'suggested'],
		['hypermode kelimesini yazınca ne oluyor', 'suggested'],
		['the hypermode mode is on', 'suggested'],
		['turn the thing hypermode now', 'suggested'],
		['can you explain hypermode?', 'suggested'],
	] as const)('keyword: %s → %s', (text, expected) => {
		expect(stateOf(text, 'hypermode')).toBe(expected)
	})

	it.each([
		['save this as a skill', 'armed'],
		['please save it as a skill', 'armed'],
		['Could you save this as a skill?', 'armed'],
		['fix the tests and then save it as a skill', 'armed'],
		['turn it into a reusable skill', 'armed'],
		['make this a skill', 'armed'],
		["don't forget to save it as a skill", 'suggested'],
		['save it as a skill named notes', 'suggested'],
		['bunu da skill olarak kaydet', 'armed'],
		['bunu skill olarak kaydeder misin?', 'armed'],
		['bunu skill olarak kaydet lütfen', 'armed'],
		['bu işi skill olarak kaydet', 'armed'],
		["bunu skill'e çevir", 'armed'],
		['bunu skill’e dönüştür', 'armed'],
		['bundan bir skill yap', 'armed'],
		['BUNU SKİLL OLARAK KAYDET', 'armed'],
		['bunu skill olarak kaydetme', 'none'],
		['skill olarak kaydetmeden önce testleri çalıştır', 'none'],
		['save it as a skill, save it as a skill', 'armed'],
	] as const)('save-skill: %s → %s', (text, expected) => {
		expect(stateOf(text, 'save-skill')).toBe(expected)
	})

	it('reads phrases for every built-in trigger in both languages', () => {
		expect(stateOf('delegate this to subagents', 'hypermode')).toBe('armed')
		expect(stateOf('bunu alt ajanlara dağıt', 'hypermode')).toBe('armed')
		expect(stateOf('run it every 5 minutes', 'schedule')).toBe('suggested')
		expect(stateOf('bunu her sabah çalıştır', 'schedule')).toBe('suggested')
		expect(stateOf('think as hard as you can', 'max-effort', ALL_ON)).toBe('armed')
		expect(stateOf('en yüksek eforla düşün', 'max-effort', ALL_ON)).toBe('armed')
		// Off by default: not matched at all.
		expect(stateOf('think as hard as you can', 'max-effort')).toBe('none')
	})

	it('ignores anything in code, quotes, URLs, paths, mentions and quoted lines', () => {
		for (const text of [
			'`hypermode` fix it',
			'```\nhypermode\n```',
			'"save it as a skill"',
			'«bunu skill olarak kaydet»',
			"'hypermode' fix it",
			'see https://x.test/hypermode',
			'open ./hypermode/save.ts',
			'@hypermode fix it',
			'> hypermode fix it',
		]) {
			expect(
				detectTriggers(text, REGISTRY, CONTEXT).hits.filter((hit) => hit.state === 'armed'),
				text,
			).toEqual([])
		}
		// An apostrophe inside a word is not a quote.
		expect(stateOf("bunu skill'e çevir", 'save-skill')).toBe('armed')
	})
})

describe('the corpora', () => {
	const fixture = (name: string) =>
		readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8')
			.split('\n')
			.filter((line) => line.trim().length > 0 && !line.startsWith('#'))

	it.each(['corpus-en.txt', 'corpus-tr.txt'])('%s arms nothing', (name) => {
		const armed = fixture(name).flatMap((line) =>
			detectTriggers(line, ALL_ON, CONTEXT)
				.hits.filter((hit) => hit.state === 'armed')
				.map((hit) => `${hit.id}: ${line}`),
		)
		expect(armed).toEqual([])
	})
})

describe('where the text came from, and Alt+W', () => {
	const text = 'hypermode fix the flaky test'
	const key = 'hypermode@0'

	it('only suggests what was not typed here', () => {
		const hit = detectTriggers(text, REGISTRY, CONTEXT, { nonTyped: [[0, text.length]] }).hits[0]
		expect(hit?.state).toBe('suggested')
		// Typed around a pasted part that does not touch the keyword: still armed.
		expect(detectTriggers(text, REGISTRY, CONTEXT, { nonTyped: [[10, 13]] }).hits[0]?.state).toBe(
			'armed',
		)
	})

	it('drops an armed trigger and arms a suggestion by key', () => {
		expect(
			detectTriggers(text, REGISTRY, CONTEXT, { overrides: new Map([[key, 'dropped']]) }).hits[0]
				?.state,
		).toBe('dropped')
		expect(
			detectTriggers(text, REGISTRY, CONTEXT, {
				nonTyped: [[0, text.length]],
				overrides: new Map([[key, 'armed']]),
			}).hits[0]?.state,
		).toBe('armed')
		// A suggest-only trigger arms by hand too.
		expect(
			detectTriggers('schedule it', REGISTRY, CONTEXT, {
				overrides: new Map([['schedule@0', 'armed']]),
			}).hits[0]?.state,
		).toBe('armed')
	})

	it('hides suggestions when they are turned off, and keeps what is armed', () => {
		const options = { suggest: false } as const
		expect(detectTriggers('what is hypermode?', REGISTRY, CONTEXT, options).hits).toEqual([])
		expect(detectTriggers(text, REGISTRY, CONTEXT, options).hits[0]?.state).toBe('armed')
	})
})

describe('availability', () => {
	it.each([
		[{ sessionHypermode: true }, 'hypermode fix it', 'already on for this session'],
		[{ agentTool: false }, 'hypermode fix it', 'unavailable: this session cannot delegate'],
		[{ permissionMode: 'plan' }, 'save it as a skill', 'unavailable in plan mode'],
		[{ permissionMode: 'strict' }, 'save it as a skill', 'unavailable in strict mode'],
		[{ skillCreator: false }, 'save it as a skill', 'unavailable: the skill-creator skill is off'],
	] as const)('%o: %s', (change, text, reason) => {
		const hit = detectTriggers(text, REGISTRY, { ...CONTEXT, ...change }).hits[0]
		expect(hit?.state).toBe('unavailable')
		expect(hit?.reason).toBe(reason)
	})

	it('offers no suggestion that could not apply', () => {
		expect(
			detectTriggers('schedule it', REGISTRY, { ...CONTEXT, permissionMode: 'plan' }).hits,
		).toEqual([])
	})
})

describe('cost', () => {
	it('stops reading past the scan limit and says so', () => {
		const long = `${'a '.repeat(MAX_SCANNED_DRAFT / 2)}hypermode`
		expect(detectTriggers(long, REGISTRY, CONTEXT)).toEqual({
			hits: [],
			onlyTriggers: false,
			paused: 'too-long',
		})
	})

	it.each([
		// Every token here begins some phrase, so every start runs the automaton.
		'bunu da yeni bir skill olarak save it as a delegate this to ',
		// One token that opens many optional paths, over and over.
		'bunu bunu ',
		'hypermode ',
	])('does linear work on a draft at the scan limit made of %j, counted in steps', (unit) => {
		const draft = unit.repeat(Math.floor((MAX_SCANNED_DRAFT - 1) / unit.length))
		const tokens = draft.split(/\s+/u).filter(Boolean).length
		const stats: MatchStats = { steps: 0 }
		detectTriggers(draft, ALL_ON, CONTEXT, { stats })
		expect(stats.steps).toBeGreaterThan(0)
		// A fixed number of automaton steps per token (measured 15–57), not a
		// number that grows with the draft.
		expect(stats.steps / tokens).toBeLessThan(100)
	})
})
