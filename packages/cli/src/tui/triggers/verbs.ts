/**
 * The Turkish verb forms a composer-trigger phrase accepts, as data.
 *
 * Not a morphological analyser: for each verb the table lists the spellings
 * that are positive requests — the imperative, its plural and formal forms,
 * the "let's" form, "would you" (`kaydeder misin`, also written joined:
 * `kaydedermisin`), "could you" (`kaydedebilir misin`), and the familiar
 * `kaydetsene`. Negative forms (`kaydetme`, `kaydetmeyin`, `kaydetmeden`,
 * `kaydetmesin`) are never generated, so a phrase cannot match one: negation
 * is rejected by construction. Everything is stored folded (`fold.ts`), so
 * `mısın` is `misin` and `dönüştür` is `donustur`.
 *
 * A form is a sequence of tokens: `kaydeder misin` is two.
 */

import { fold } from './fold.js'

export interface VerbForm {
	/** Folded tokens, e.g. `['kaydeder', 'misin']`. */
	readonly tokens: readonly string[]
	/** A polite question (`… misin?`): a request even in a clause ending with `?`. */
	readonly polite: boolean
	/** The "let's" form, a request when followed by the question particle `mi`. */
	readonly optative: boolean
}

interface VerbSpec {
	/** Imperative, as written. */
	readonly imperative: string
	/** Plural and formal imperatives. */
	readonly plural: readonly string[]
	/** First person plural optative ("let's"). */
	readonly optative: string
	/** The aorist that `misin` follows ("would you"). */
	readonly aorist: string
	/** `misin` or `musun`, by vowel harmony, as written. */
	readonly particle: 'mısın' | 'misin' | 'musun' | 'müsün'
	/** The abilitative stem ("could you"), up to and including `-bilir`. */
	readonly abilitative: string
	/** The familiar `-sene`/`-sana` form. */
	readonly familiar: string
}

const SPECS: Readonly<Record<string, VerbSpec>> = {
	kaydet: {
		imperative: 'kaydet',
		plural: ['kaydedin', 'kaydediniz'],
		optative: 'kaydedelim',
		aorist: 'kaydeder',
		particle: 'misin',
		abilitative: 'kaydedebilir',
		familiar: 'kaydetsene',
	},
	çevir: {
		imperative: 'çevir',
		plural: ['çevirin', 'çeviriniz'],
		optative: 'çevirelim',
		aorist: 'çevirir',
		particle: 'misin',
		abilitative: 'çevirebilir',
		familiar: 'çevirsene',
	},
	dönüştür: {
		imperative: 'dönüştür',
		plural: ['dönüştürün', 'dönüştürünüz'],
		optative: 'dönüştürelim',
		aorist: 'dönüştürür',
		particle: 'müsün',
		abilitative: 'dönüştürebilir',
		familiar: 'dönüştürsene',
	},
	yap: {
		imperative: 'yap',
		plural: ['yapın', 'yapınız'],
		optative: 'yapalım',
		aorist: 'yapar',
		particle: 'mısın',
		abilitative: 'yapabilir',
		familiar: 'yapsana',
	},
	oluştur: {
		imperative: 'oluştur',
		plural: ['oluşturun', 'oluşturunuz'],
		optative: 'oluşturalım',
		aorist: 'oluşturur',
		particle: 'musun',
		abilitative: 'oluşturabilir',
		familiar: 'oluştursana',
	},
	çalıştır: {
		imperative: 'çalıştır',
		plural: ['çalıştırın', 'çalıştırınız'],
		optative: 'çalıştıralım',
		aorist: 'çalıştırır',
		particle: 'mısın',
		abilitative: 'çalıştırabilir',
		familiar: 'çalıştırsana',
	},
	dağıt: {
		imperative: 'dağıt',
		plural: ['dağıtın', 'dağıtınız'],
		optative: 'dağıtalım',
		aorist: 'dağıtır',
		particle: 'mısın',
		abilitative: 'dağıtabilir',
		familiar: 'dağıtsana',
	},
	düşün: {
		imperative: 'düşün',
		plural: ['düşünün', 'düşününüz'],
		optative: 'düşünelim',
		aorist: 'düşünür',
		particle: 'müsün',
		abilitative: 'düşünebilir',
		familiar: 'düşünsene',
	},
	ekle: {
		imperative: 'ekle',
		plural: ['ekleyin', 'ekleyiniz'],
		optative: 'ekleyelim',
		aorist: 'ekler',
		particle: 'misin',
		abilitative: 'ekleyebilir',
		familiar: 'eklesene',
	},
}

/** The verbs a phrase may name as `{verb}`, by their folded imperative. */
export const VERB_NAMES: readonly string[] = Object.keys(SPECS).map(fold)

const FORMS = new Map<string, readonly VerbForm[]>()
for (const spec of Object.values(SPECS)) FORMS.set(fold(spec.imperative), formsOf(spec))

function formsOf(spec: VerbSpec): readonly VerbForm[] {
	const plain = (
		text: string,
		flags: Partial<Pick<VerbForm, 'polite' | 'optative'>> = {},
	): VerbForm => ({
		tokens: fold(text).split(' '),
		polite: flags.polite ?? false,
		optative: flags.optative ?? false,
	})
	const plural = fold(spec.particle) === 'musun' ? 'musunuz' : 'misiniz'
	// `-sene`/`-sana` and their plural `-senize`/`-sanıza`; `-sen` is the
	// softer "would you".
	const familiarPlural = spec.familiar.endsWith('a')
		? `${spec.familiar.slice(0, -1)}ıza`
		: `${spec.familiar.slice(0, -1)}ize`
	return [
		plain(spec.imperative),
		...spec.plural.map((form) => plain(form)),
		plain(spec.optative, { optative: true }),
		plain(`${spec.aorist} ${spec.particle}`, { polite: true }),
		plain(`${spec.aorist} ${plural}`, { polite: true }),
		plain(`${spec.aorist}${spec.particle}`, { polite: true }),
		plain(`${spec.abilitative} misin`, { polite: true }),
		plain(`${spec.abilitative} misiniz`, { polite: true }),
		plain(`${spec.abilitative}misin`, { polite: true }),
		plain(spec.familiar),
		plain(familiarPlural),
		plain(spec.familiar.slice(0, -1)),
	]
}

/** Every accepted form of `verb` (folded imperative), or throws for a verb the table does not have. */
export function verbForms(verb: string): readonly VerbForm[] {
	const forms = FORMS.get(fold(verb))
	if (!forms) throw new Error(`No verb table entry for "${verb}".`)
	return forms
}

/** The question particles that may follow a form directly (`kaydedelim mi`). */
export const QUESTION_PARTICLES: ReadonlySet<string> = new Set(['mi', 'mu'])
