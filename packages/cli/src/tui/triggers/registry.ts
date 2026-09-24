/**
 * Composer triggers: words typed into the TUI composer that name one namzu
 * action for the message being written, shown before Enter and dropped with
 * Alt+W. See docs/cli/composer-triggers.md.
 *
 * A trigger is a shorthand for something namzu already does. It grants
 * nothing, skips no confirmation and lasts one turn: `TriggerEffect` has no
 * kind for a permission mode, a directory, a credential, the sandbox, a tool
 * list or a limit, and a test pins that. The operator's words reach the model
 * and the log unchanged; namzu's own words for a trigger travel beside them as
 * request-only context (`context-text.ts`).
 *
 * This module is the TUI's alone: `exec`, `drain`, ACP, the scheduler and
 * sub-agents never import it (a test says so).
 */

import { COMPOSER_TRIGGER_DEFAULTS, COMPOSER_TRIGGER_IDS } from '../../config/composer-triggers.js'
import type { ComposerTriggerId } from '../../config/schema.js'
import { fold } from './fold.js'
import { type CompiledPattern, compilePattern } from './pattern.js'
import { verbForms } from './verbs.js'

export type TriggerId = ComposerTriggerId

export const TRIGGER_IDS: readonly TriggerId[] = COMPOSER_TRIGGER_IDS

/**
 * What a trigger does when the text arms it.
 *
 * - `arm`: a strict match arms; a loose one, or text not typed here, suggests.
 * - `suggest`: never arms from text; the tag row offers it, Alt+W arms it.
 * - `off`: not matched at all.
 */
export type Arming = 'arm' | 'suggest' | 'off'

export type TriggerLocale = 'en' | 'tr'

/** The fixed texts namzu adds for a turn; operator text never enters them. */
export type ContextTextId = 'hypermode' | 'save-skill' | 'schedule'

/** A command a trigger may run after its turn. Only this one exists. */
export type TriggerableCommand = '/skills save'

export type TriggerEffect =
	/**
	 * Request-only context for the turn, and optionally an effort for it:
	 * `hypermode`, the level `/hypermode` pins (`xhigh`, or the nearest below).
	 */
	| { readonly kind: 'turn-context'; readonly text: ContextTextId; readonly effort?: 'hypermode' }
	/** The model's highest published effort for this turn only (max effort). */
	| { readonly kind: 'turn-effort'; readonly effort: 'highest' }
	/** A command run once after the turn the message lands in, when that turn did work. */
	| {
			readonly kind: 'after-turn'
			readonly command: TriggerableCommand
			readonly text: ContextTextId
	  }

export interface PhraseSpec {
	readonly pattern: string
	/**
	 * Which edges of the match must be clause edges for it to be strict.
	 * English puts the verb first, so both; Turkish puts it last, so the right
	 * edge carries the request and the left may be any object.
	 */
	readonly edges: 'both' | 'right'
}

/**
 * A loose match: every slot has a token in one clause, in any order. A slot
 * entry is a word, `word*` for a prefix (loanwords with Turkish suffixes:
 * `skille`, `skillerimi`), or `{verb}` for any of its forms' first token.
 */
export type LooseSpec = readonly (readonly string[])[]

export interface TriggerDefinition {
	readonly id: TriggerId
	/** Shown in the tag row. */
	readonly label: string
	/** Invented single words; they arm only at a clause edge. */
	readonly keywords: readonly string[]
	readonly phrases: Readonly<Partial<Record<TriggerLocale, readonly PhraseSpec[]>>>
	readonly loose: Readonly<Partial<Record<TriggerLocale, readonly LooseSpec[]>>>
	readonly effect: TriggerEffect
	/** `turn`: the new turn this message starts. `after-turn`: once, after the turn it lands in. */
	readonly scope: 'turn' | 'after-turn'
	/** A whole message that is only this trigger runs this command instead of a prompt. */
	readonly standalone?: TriggerableCommand
	readonly arming: Arming
}

const both = (pattern: string): PhraseSpec => ({ pattern, edges: 'both' })
const right = (pattern: string): PhraseSpec => ({ pattern, edges: 'right' })

/** The built-in triggers, in the order their tags are shown. */
export const BUILTIN_TRIGGERS: readonly TriggerDefinition[] = [
	{
		id: 'hypermode',
		label: 'hypermode',
		keywords: ['hypermode'],
		phrases: {
			en: [
				both(
					'[please] delegate (this|it|that) to (agents|subagents|sub agents|parallel agents) [please]',
				),
				both('[please] use (subagents|sub agents|parallel agents) for (this|it|that) [please]'),
			],
			tr: [
				right(
					"[lütfen] (bunu|bunları|onu) (ajanlara|alt ajanlara|agent+'|subagent+') {dağıt} [lütfen]",
				),
				right(
					'(bunu|bunları|onu) (alt ajanlarla|ajanlarla|agentlarla|subagentlarla) {yap} [lütfen]',
				),
			],
		},
		loose: {
			en: [[['delegate'], ['agents', 'subagents']]],
			tr: [
				[
					['ajanlara', 'agent*', 'subagent*', 'ajanlarla'],
					['{dağıt}', '{yap}'],
				],
			],
		},
		effect: { kind: 'turn-context', text: 'hypermode', effort: 'hypermode' },
		scope: 'turn',
		arming: COMPOSER_TRIGGER_DEFAULTS.hypermode,
	},
	{
		id: 'save-skill',
		label: 'save as skill',
		keywords: [],
		phrases: {
			en: [
				both(
					'[please|now|can you|could you|would you|will you] (save|turn) (this|it|that) (as|into) [a|an] [new|reusable] skill [please]',
				),
				both(
					'[please|now|can you|could you|would you|will you] make (this|it|that) [into] (a|an) [new|reusable] skill [please]',
				),
			],
			tr: [
				right(
					'[lütfen] [bunu|bunları|onu] [da|de] [yeni] [bir] (skill|beceri|yetenek) olarak {kaydet} [lütfen]',
				),
				right(
					"[lütfen] (bunu|bunları|onu) [da|de] (skill+'|beceri+'|yetenek+') {çevir|dönüştür} [lütfen]",
				),
				right('bundan [bir] [yeni] (skill|beceri|yetenek) {yap|oluştur} [lütfen]'),
			],
		},
		loose: {
			en: [[['save', 'turn', 'make'], ['this', 'it', 'that'], ['skill']]],
			tr: [
				[
					['skill*', 'beceri*', 'yetenek*'],
					['{kaydet}', '{çevir}', '{dönüştür}', '{yap}', '{oluştur}'],
				],
			],
		},
		effect: { kind: 'after-turn', command: '/skills save', text: 'save-skill' },
		scope: 'after-turn',
		standalone: '/skills save',
		arming: COMPOSER_TRIGGER_DEFAULTS['save-skill'],
	},
	{
		id: 'schedule',
		label: 'schedule',
		keywords: [],
		phrases: {
			en: [
				both('schedule (this|it) [with namzu]'),
				both('run (this|it) every (day|morning|evening|night|hour|week|<n> (minutes|hours|days))'),
			],
			tr: [
				right('(bunu|onu) her (gün|sabah|akşam|saat|hafta) {çalıştır}'),
				right('(bunu|onu) zamanlanmış görev olarak {kaydet|ekle}'),
			],
		},
		loose: {},
		effect: { kind: 'turn-context', text: 'schedule' },
		scope: 'turn',
		// Phrases about a schedule usually describe the code being written
		// ("write a backup script and schedule it"): offered, never armed.
		arming: COMPOSER_TRIGGER_DEFAULTS.schedule,
	},
	{
		id: 'max-effort',
		label: 'max effort',
		keywords: [],
		phrases: {
			en: [both('think (as hard as you can|at max effort|at maximum effort)')],
			tr: [right('en yüksek (eforla|çabayla) {düşün}')],
		},
		loose: {},
		effect: { kind: 'turn-effort', effort: 'highest' },
		scope: 'turn',
		arming: COMPOSER_TRIGGER_DEFAULTS['max-effort'],
	},
]

/** A trigger with its phrases compiled, as the matcher reads it. */
export interface CompiledTrigger {
	readonly definition: TriggerDefinition
	readonly arming: Arming
	readonly keywords: ReadonlySet<string>
	readonly phrases: readonly {
		readonly pattern: CompiledPattern
		readonly edges: PhraseSpec['edges']
		readonly locale: TriggerLocale
	}[]
	readonly loose: readonly {
		readonly slots: readonly ((token: string) => boolean)[]
		readonly locale: TriggerLocale
	}[]
}

export interface RegistryOptions {
	/** Per-trigger arming, after config; absent keeps the built-in default. */
	readonly arming?: Readonly<Partial<Record<TriggerId, Arming>>>
	readonly locales?: readonly TriggerLocale[]
}

export interface TriggerRegistry {
	readonly triggers: readonly CompiledTrigger[]
	/** Changes whenever the compiled set does; part of the detection memo key. */
	readonly version: string
}

export function compileRegistry(
	definitions: readonly TriggerDefinition[] = BUILTIN_TRIGGERS,
	options: RegistryOptions = {},
): TriggerRegistry {
	const locales = new Set<TriggerLocale>(options.locales ?? ['en', 'tr'])
	const triggers: CompiledTrigger[] = []
	for (const definition of definitions) {
		const arming = options.arming?.[definition.id] ?? definition.arming
		if (arming === 'off') continue
		triggers.push({
			definition,
			arming,
			keywords: new Set(definition.keywords.map(fold)),
			phrases: (Object.entries(definition.phrases) as [TriggerLocale, readonly PhraseSpec[]][])
				.filter(([locale]) => locales.has(locale))
				.flatMap(([locale, specs]) =>
					specs.map((spec) => ({
						pattern: compilePattern(spec.pattern),
						edges: spec.edges,
						locale,
					})),
				),
			loose: (Object.entries(definition.loose) as [TriggerLocale, readonly LooseSpec[]][])
				.filter(([locale]) => locales.has(locale))
				.flatMap(([locale, specs]) =>
					specs.map((slots) => ({ slots: slots.map(slotMatcher), locale })),
				),
		})
	}
	const armings = triggers.map((trigger) => `${trigger.definition.id}:${trigger.arming}`)
	const version = `${armings.join(',')}|${[...locales].join(',')}`
	return { triggers, version }
}

function slotMatcher(entries: readonly string[]): (token: string) => boolean {
	const exact = new Set<string>()
	const prefixes: string[] = []
	for (const entry of entries) {
		if (entry.startsWith('{') && entry.endsWith('}')) {
			for (const form of verbForms(entry.slice(1, -1))) exact.add(form.tokens[0] as string)
		} else if (entry.endsWith('*')) prefixes.push(fold(entry.slice(0, -1)))
		else exact.add(fold(entry))
	}
	return (token) => exact.has(token) || prefixes.some((prefix) => token.startsWith(prefix))
}

export function triggerDefinition(id: TriggerId): TriggerDefinition {
	const found = BUILTIN_TRIGGERS.find((trigger) => trigger.id === id)
	if (!found) throw new Error(`Unknown trigger ${id}`)
	return found
}
