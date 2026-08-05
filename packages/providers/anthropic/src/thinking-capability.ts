import { parseVersionedModelId } from '@namzu/sdk'
import type { ModelIdGrammar, ReasoningEffort, ThinkingConfig } from '@namzu/sdk'

/**
 * What a given model will actually accept for thinking.
 *
 * This exists because the vendor **rejects** a mismatched mode rather than
 * degrading it. A request carrying `thinking: {type: "enabled"}` to a current
 * model comes back 400 with `"thinking.type.enabled" is not supported for this
 * model`; the same request with `"adaptive"` to an older one comes back
 * `adaptive thinking is not supported on this model`. So sending one body to
 * every model is not a compatibility compromise, it is a failed request — and
 * the SDK's `ThinkingConfig` is deliberately a statement of *intent* that each
 * driver resolves against the model it is about to call.
 *
 * The split, from the vendor's per-model table:
 *
 * - **Adaptive only** — Fable 5, Mythos 5, Opus 5, Sonnet 5, Opus 4.8, Opus
 *   4.7. These reject `enabled`. Fable 5 and Mythos 5 additionally reject
 *   `disabled` because they cannot stop thinking at all.
 * - **Both** — Opus 4.6, Sonnet 4.6 (manual mode deprecated but working), and
 *   Mythos Preview (which rejects `disabled`).
 * - **Manual only** — Opus 4.5, Sonnet 4.5, Haiku 4.5, Opus 4.1. These reject
 *   `adaptive`.
 *
 * Unknown models are treated as manual-only, which is the pre-existing
 * behaviour and therefore the safe answer for a name this table has not seen:
 * a third-party gateway serving an older model keeps working, and the failure
 * mode for a newer one is a clear vendor 400 rather than a silently altered
 * request.
 */
/**
 * The effort levels a model accepts — a SET, not a flag.
 *
 * Modelling this as a boolean was wrong in the same way `oneOf` under strict
 * was wrong: the vendor rejects a level a model does not have rather than
 * clamping it, so `xhigh` on a 4.6 and `max` on a 4.5 were 400s this driver
 * forwarded without noticing. The ceiling moved twice — `xhigh` arrived with
 * 4.7, and `max` is absent below 4.6 — so there is no single answer to encode.
 *
 * Empty means the model takes no `effort` field at all.
 */
export type EffortLevels = readonly ReasoningEffort[]

const NO_EFFORT: EffortLevels = []
/** Everything from 4.7 onward, plus the always-on families. */
const FULL_EFFORT: EffortLevels = ['low', 'medium', 'high', 'xhigh', 'max']
/** 4.6: `max` exists, `xhigh` does not — it arrived with 4.7. */
const EFFORT_WITHOUT_XHIGH: EffortLevels = ['low', 'medium', 'high', 'max']
/** 4.5: neither `xhigh` nor `max`. */
const EFFORT_BASE: EffortLevels = ['low', 'medium', 'high']

export interface ThinkingCapability {
	readonly adaptive: boolean
	readonly manual: boolean
	/** False on models that cannot turn thinking off. */
	readonly canDisable: boolean
	/** Which `effort` levels this model accepts; empty means none. */
	readonly effort: EffortLevels
	/**
	 * The levels still accepted when thinking is switched off.
	 *
	 * Usually the same set. The Opus 5 family is the exception: it refuses
	 * `xhigh` and `max` alongside `thinking: {type:"disabled"}` — *"effort 'max'
	 * is not supported when thinking is disabled"* — while accepting `high`.
	 *
	 * This started as a blanket rule applied to every model that can disable
	 * thinking, on the reasoning that the pairing is incoherent anyway. Measured,
	 * that was too wide: Sonnet 5 and Opus 4.8 both accept `disabled` + `max`,
	 * so the blanket rule was silently dropping an effort the caller asked for
	 * and the wire would have honoured. Incoherent-looking is not the same as
	 * rejected, and only the wire gets to say which.
	 */
	readonly effortWhenDisabled: EffortLevels
}

const MANUAL_ONLY: ThinkingCapability = {
	adaptive: false,
	manual: true,
	canDisable: true,
	effort: NO_EFFORT,
	effortWhenDisabled: NO_EFFORT,
}

/**
 * The vocabulary this driver's ids are spelled in.
 *
 * The matcher itself is `parseVersionedModelId` in the kernel; only these
 * words are local, because only this package knows them. The comment that
 * stood here warned that "a second, subtly different model matcher in the same
 * file is how two capability decisions drift apart on the same model name" —
 * and there were three copies of it, this file and two drivers, all with the
 * same defect: the minor group was `\d+`, so it swallowed the 8-digit date
 * suffix and a dated id naming no minor parsed as minor 20250514. The warning
 * was right, and the answer to it was not another careful copy.
 */
export const MODEL_ID_GRAMMAR: ModelIdGrammar = {
	product: 'claude',
	families: ['haiku', 'sonnet', 'opus', 'fable', 'mythos'],
	routingPrefix: 'anthropic/',
}

export function resolveThinkingCapability(model: string): ThinkingCapability {
	const normalized = model.toLowerCase()

	// Named rather than versioned: the preview carries no version number the
	// parser can compare, and it is the one model supporting both modes while
	// refusing to be switched off.
	if (/^(?:anthropic\/)?claude-mythos-preview$/.test(normalized)) {
		return {
			adaptive: true,
			manual: true,
			canDisable: false,
			effort: FULL_EFFORT,
			effortWhenDisabled: FULL_EFFORT,
		}
	}

	const parsed = parseVersionedModelId(model, MODEL_ID_GRAMMAR)
	if (!parsed) return MANUAL_ONLY

	const { family, major, minor } = parsed

	// Always-on families: thinking cannot be disabled at any version.
	if (family === 'fable' || family === 'mythos') {
		return {
			adaptive: true,
			manual: false,
			canDisable: false,
			effort: FULL_EFFORT,
			effortWhenDisabled: FULL_EFFORT,
		}
	}

	// 4.7 and later dropped manual mode outright.
	if (major > 4 || (major === 4 && minor >= 7)) {
		// The Opus 5 family alone caps effort while thinking is off. Measured,
		// not inferred: `claude-opus-5` refuses `disabled` + `xhigh`/`max` and
		// accepts `disabled` + `high`, while `claude-sonnet-5` and
		// `claude-opus-4-8` accept `disabled` + `max`. A version comparison of
		// "5 and later" would have caught Sonnet 5 too and dropped an effort
		// that wire honours.
		const opus5Plus = family === 'opus' && major >= 5
		return {
			adaptive: true,
			manual: false,
			canDisable: true,
			effort: FULL_EFFORT,
			effortWhenDisabled: opus5Plus ? EFFORT_BASE : FULL_EFFORT,
		}
	}

	// 4.6 accepts both; manual is deprecated there but still functional.
	if (major === 4 && minor === 6) {
		return {
			adaptive: true,
			manual: true,
			canDisable: true,
			effort: EFFORT_WITHOUT_XHIGH,
			effortWhenDisabled: EFFORT_WITHOUT_XHIGH,
		}
	}

	// 4.5 and earlier are manual-only. Opus 4.5 is the one that also takes
	// effort, where effort shapes the answer and the budget sets depth — and it
	// takes only the first three levels: `xhigh` did not exist yet and `max`
	// is rejected there.
	const isOpus45 = family === 'opus' && major === 4 && minor === 5
	const base = isOpus45 ? EFFORT_BASE : NO_EFFORT
	return { ...MANUAL_ONLY, effort: base, effortWhenDisabled: base }
}

/** The `thinking` body value, or `undefined` to send no thinking field. */
export type ResolvedThinkingBody =
	| { type: 'adaptive'; display?: 'summarized' | 'omitted' }
	| { type: 'enabled'; budget_tokens?: number; display?: 'summarized' | 'omitted' }
	| { type: 'disabled' }
	| undefined

/**
 * Turn a declared intent into a body this model accepts, or into nothing.
 *
 * Omission is a real answer and the reason this returns `undefined` rather
 * than throwing. A caller asking to disable thinking on a model that cannot
 * disable it has asked for something impossible — but failing the request
 * teaches nothing the vendor's own 400 would not, and it breaks a caller whose
 * config is shared across models. Sending no `thinking` field leaves the model
 * on its documented default, which is the closest honest reading of "I did not
 * want to spend on this".
 *
 * The same holds in reverse: an `enabled` intent on an adaptive-only model
 * becomes `adaptive`, because the caller asked for thinking and this model's
 * way of thinking is adaptive. The budget is dropped with it — it has no
 * meaning there, and `effort` is the depth control instead.
 */
export function resolveThinkingBody(
	thinking: ThinkingConfig | undefined,
	capability: ThinkingCapability,
): ResolvedThinkingBody {
	if (!thinking) return undefined

	const display = thinking.display ? { display: thinking.display } : {}

	if (thinking.type === 'disabled') {
		return capability.canDisable ? { type: 'disabled' } : undefined
	}

	if (thinking.type === 'adaptive') {
		if (capability.adaptive) return { type: 'adaptive', ...display }
		// Manual-only model: honour the intent to think, with the one mode it
		// has. No budget was given, so the vendor default applies.
		return capability.manual ? { type: 'enabled', ...display } : undefined
	}

	// 'enabled'
	if (capability.manual) {
		return {
			type: 'enabled',
			...(thinking.budgetTokens !== undefined ? { budget_tokens: thinking.budgetTokens } : {}),
			...display,
		}
	}
	return capability.adaptive ? { type: 'adaptive', ...display } : undefined
}

/**
 * Whether `effort` may ride on this request.
 *
 * Two things get checked, and the second used to be missed entirely.
 *
 * The LEVEL has to be one this model has. The ceiling moved twice — `xhigh`
 * arrived with 4.7, and `max` does not exist below 4.6 — so `capability.effort`
 * is a set rather than a flag. It was a flag, which meant `xhigh` on a 4.6 and
 * `max` on a 4.5 were forwarded to a vendor that rejects an unknown level
 * rather than clamping it. Dropping the field is right where the level does
 * not exist: `effort` shapes an answer the model will still produce, so a
 * request without it is the same request at the model's own default, whereas
 * refusing would fail a call that has a correct answer.
 *
 * The COMBINATION has to be legal, and the legal set is per model rather than
 * universal. Opus 5 accepts `thinking: {type: "disabled"}` at `high` or below
 * and **rejects it at `xhigh`/`max`** — so this asks the capability for the set
 * that applies when thinking is off, instead of the set that applies generally.
 *
 * That distinction was earned. The rule started as a blanket refusal on every
 * model that can disable thinking, on the reasoning that the pairing is
 * incoherent anyway — asking a model not to think and then to think as hard as
 * possible. Measured, Sonnet 5 and Opus 4.8 both accept it, so the blanket rule
 * was discarding an effort the caller asked for and the wire would have
 * honoured. Incoherent-looking is not the same as rejected.
 */
export function resolveEffort(
	effort: ReasoningEffort | undefined,
	thinkingBody: ResolvedThinkingBody,
	capability: ThinkingCapability,
): ReasoningEffort | undefined {
	if (effort === undefined) return undefined
	const allowed =
		thinkingBody?.type === 'disabled' ? capability.effortWhenDisabled : capability.effort
	return allowed.includes(effort) ? effort : undefined
}
