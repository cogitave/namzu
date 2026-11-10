import { ProviderRequestError, parseVersionedModelId } from '@namzu/sdk'

import { MODEL_ID_GRAMMAR } from './thinking-capability.js'
import { type VersionFloor, reachesFloor } from './version-floor.js'

/**
 * Fast mode: `speed: "fast"` on the Messages request, a premium low-latency
 * mode billed at twice the standard rates.
 *
 * Source: the vendor's fast-mode page and release notes (checked 2026-11-10).
 * https://platform.claude.com/docs/en/build-with-claude/fast-mode and
 * https://platform.claude.com/docs/en/release-notes/overview.
 *
 * Two kinds of model take it, and they differ in the one thing this module
 * decides besides admission, the beta header:
 *
 * - Generally available from a floor, with NO beta header: Opus 5.5, Fable 5.2
 *   and Mythos 5.2. A floor and not a list, so the next release in those
 *   families inherits the answer (the same trade `version-floor.ts` explains).
 * - Research preview, which still needs the `fast-mode-2026-02-01` beta header:
 *   Opus 5 and Opus 4.8 only, named exactly because no floor describes them.
 *
 * Everything else is refused here, before transport. Opus 4.7 and Opus 4.8
 * after its removal date answer a fast request with an error; Opus 4.6 would
 * silently run at standard speed while the caller believes otherwise. Refusing
 * all of them keeps one rule: `fast` means fast or an error.
 */

/** The beta header the research-preview models still require. */
export const FAST_MODE_BETA = 'fast-mode-2026-02-01'

const FAST_GA_FROM: readonly VersionFloor[] = [
	{ family: 'opus', major: 5, minor: 5 },
	{ family: 'fable', major: 5, minor: 2 },
	{ family: 'mythos', major: 5, minor: 2 },
]

interface PreviewModel {
	readonly family: string
	readonly major: number
	readonly minor: number
	/** First instant (UTC) at which the vendor no longer serves fast mode on it. */
	readonly removedAt?: number
	/** What to use instead, named in the refusal. */
	readonly replacement?: string
}

const FAST_PREVIEW: readonly PreviewModel[] = [
	{ family: 'opus', major: 5, minor: 0 },
	{
		family: 'opus',
		major: 4,
		minor: 8,
		// Deprecated 2026-10-30, removed 2026-11-30: a request with speed "fast"
		// then returns an error. Migration target is Claude Opus 5.5.
		removedAt: Date.UTC(2026, 10, 30),
		replacement: 'claude-opus-5-5',
	},
]

export type FastModeVerdict =
	| { readonly ok: true; readonly beta?: string }
	| { readonly ok: false; readonly reason: string }

/**
 * Whether `speed: "fast"` may be sent to `model` at time `now` (epoch ms), and
 * the beta header it needs. Pure: the clock is a parameter so the removal date
 * can be tested without waiting for it.
 */
export function resolveFastMode(model: string, now: number): FastModeVerdict {
	const version = parseVersionedModelId(model, MODEL_ID_GRAMMAR)
	if (version === undefined) {
		return {
			ok: false,
			reason: `Fast mode is not known to be available on model "${model}". It is offered on Claude Opus 5.5, Fable 5.2 and Mythos 5.2 (and, in research preview, Opus 5).`,
		}
	}
	const preview = FAST_PREVIEW.find(
		(m) => m.family === version.family && m.major === version.major && m.minor === version.minor,
	)
	if (preview !== undefined) {
		if (preview.removedAt !== undefined && now >= preview.removedAt) {
			return {
				ok: false,
				reason: `Fast mode was removed from model "${model}" on ${new Date(preview.removedAt).toISOString().slice(0, 10)} and the vendor now answers it with an error.${preview.replacement ? ` Use "${preview.replacement}" instead.` : ''}`,
			}
		}
		return { ok: true, beta: FAST_MODE_BETA }
	}
	if (reachesFloor(version, FAST_GA_FROM)) return { ok: true }
	return {
		ok: false,
		reason: `Model "${model}" has no fast mode. It is offered on Claude Opus 5.5, Fable 5.2 and Mythos 5.2 (and, in research preview, Opus 5); omit speed or choose one of those models.`,
	}
}

/**
 * Whether this model takes `speed: "fast"` right now. Same decision the
 * request path makes, for a caller (a CLI toggle, a model picker) deciding
 * whether to offer it.
 */
export function supportsFastMode(model: string, now: number = Date.now()): boolean {
	return resolveFastMode(model, now).ok
}

/**
 * Refuse, before transport, a fast request the vendor would error on or
 * quietly serve at standard speed. Returns the beta header to send, if any.
 * The error is the `bad_request` the vendor's 400 would have become, with its
 * own code, like `assertForcedToolChoiceAccepted`.
 */
export function assertFastModeAccepted(
	model: string,
	now: number,
	compatibleEndpoint: boolean,
): string | undefined {
	const verdict = compatibleEndpoint
		? ({
				ok: false,
				reason:
					'Fast mode is a first-party Anthropic feature; a compatible third-party endpoint is not known to honour it.',
			} as const)
		: resolveFastMode(model, now)
	if (verdict.ok) return verdict.beta
	throw new ProviderRequestError({
		kind: 'bad_request',
		providerId: 'anthropic',
		providerCode: 'fast_mode_unsupported',
		detail: verdict.reason,
	})
}

/** The beta header a request already admitted to fast mode must carry, if any. */
export function fastModeBeta(model: string): string | undefined {
	// The clock is irrelevant here: admission (and the removal date) was decided
	// by `assertFastModeAccepted`; this only reads which header the model needs.
	const verdict = resolveFastMode(model, 0)
	return verdict.ok ? verdict.beta : undefined
}
