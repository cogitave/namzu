/**
 * What a health probe against this wire concluded, and why.
 *
 * `healthCheck` used to answer with one bit produced by `catch { return false }`.
 * The three failures a caller actually needs apart — the credential is wrong,
 * the service is down, that model is not invokable here — all arrived as
 * `false`, and so did success, because the id it probed was one the driver's
 * own `assertModelReachable` classifies as unreachable. A check that cannot
 * pass is the same defect class as a check that cannot fail: neither carries
 * information, and this one carried none in a shape that looked like an outage.
 *
 * So the reason is a value rather than a sentence. `status` is the
 * `DoctorCheckResult` field `runDoctor()` reads; `reason` is what a caller
 * switches on.
 */

import type { DoctorCheckResult } from '@namzu/sdk'
import { providerVendorError } from '@namzu/sdk'

/**
 * Why the probe reached the verdict it did.
 *
 * Named for what an operator would do next, which is why `credentials` and
 * `unreachable-model` are separate from `refused`: the first is a key to
 * rotate, the second an id to change, the third a request the service looked
 * at and would not take.
 */
export type BedrockHealthReason =
	/** The model answered. */
	| 'ok'
	/** Nothing was probed: no model id was given and this driver holds none. */
	| 'no-model'
	/** The driver's own reachability rule refuses this id; nothing was sent. */
	| 'unreachable-model'
	/** No AWS credentials could be resolved on this machine. Never left it. */
	| 'no-credentials'
	/** AWS answered and rejected the credential or its permissions. */
	| 'credentials'
	/** The id is well-formed but this region serves no such model. */
	| 'unknown-model'
	/** The service looked at the request and refused it. */
	| 'refused'
	/** Reached, authenticated, and rate limited. The probe did not complete. */
	| 'throttled'
	/** The service answered and could not serve the request. */
	| 'service'
	/** Nothing was learned: the request did not get an answer. */
	| 'unreachable-service'

/**
 * A `DoctorCheckResult` with the reason kept.
 *
 * Extends rather than replaces so it satisfies `LLMProvider.doctorCheck`
 * unchanged: `runDoctor()` reads `status` and never sees the extra field, and a
 * caller holding the concrete driver reads `reason` without a cast.
 */
export interface BedrockHealthReport extends DoctorCheckResult {
	readonly reason: BedrockHealthReason
	/** The id that was probed. Absent only when nothing was probed. */
	readonly model?: string
}

/**
 * AWS models its failures as distinct exception CLASSES rather than as status
 * codes, and the class is the only thing that separates the cases an operator
 * acts on differently.
 *
 * The SDK's `providerVendorError` deliberately flattens these into six kinds
 * for the request path, where the question is "retry, compact, or give up".
 * That is the right shape there and the wrong one here: it merges
 * `ResourceNotFoundException` ("no such model in this region") with
 * `ValidationException` ("the request was invalid") into `bad_request`, and
 * those are the two answers a health check exists to tell apart. So the class
 * is read here, where the raw error is still in hand.
 *
 * Matched on `name` rather than with `instanceof`: the exception classes are
 * re-exported by every minor of the AWS SDK, and a caller running two copies of
 * `@aws-sdk/client-bedrock-runtime` in one tree would fail every `instanceof`
 * against errors that are otherwise correct.
 */
const REASON_BY_EXCEPTION: ReadonlyArray<readonly [RegExp, BedrockHealthReason]> = [
	// Client-side, before a packet leaves: the credential chain found nothing.
	// This is a definite answer about the machine, not a failure to reach AWS,
	// and filing it as unreachable would tell someone with no credentials at
	// all to go and check their network.
	[/CredentialsProviderError|CredentialsError/i, 'no-credentials'],
	[/AccessDenied|UnrecognizedClient|InvalidSignature|Unauthorized|Forbidden/i, 'credentials'],
	[/ResourceNotFound/i, 'unknown-model'],
	[/ThrottlingException|TooManyRequests|ServiceQuotaExceeded/i, 'throttled'],
	[
		/ServiceUnavailable|InternalServer|ModelNotReady|ModelTimeout|ModelStreamError|ModelError/i,
		'service',
	],
	[/Validation/i, 'refused'],
]

const STATUS_BY_REASON: Readonly<Record<BedrockHealthReason, DoctorCheckResult['status']>> = {
	ok: 'pass',
	'no-model': 'skipped',
	'unreachable-model': 'fail',
	'no-credentials': 'fail',
	credentials: 'fail',
	'unknown-model': 'fail',
	refused: 'fail',
	// Reached, authenticated, throttled. The service is up, so this is not a
	// failure of the integration — but the probe did not complete, so it is
	// not a pass either, and reporting it as one would let a caller start
	// sending traffic on the strength of a request that never ran.
	throttled: 'warn',
	service: 'fail',
	// The check did not answer. Distinct from `fail` because nothing is known:
	// telling an operator on broken wifi that Bedrock is down sends them to
	// the wrong place.
	'unreachable-service': 'inconclusive',
}

const REMEDIATION_BY_REASON: Readonly<Partial<Record<BedrockHealthReason, string>>> = {
	'no-credentials':
		'Pass accessKeyId/secretAccessKey to the driver, or make the AWS default credential chain resolve here (env, shared config, SSO, or an instance role).',
	credentials:
		'Check the credential is current and that its IAM policy allows bedrock:InvokeModelWithResponseStream on this model in this region.',
	'unknown-model':
		'This region serves no model by that id. Enable model access in the target region, or use the inference-profile form (us./eu./apac./jp./global.) for a model served cross-region.',
	refused:
		'The service rejected the request itself. A model served only through an inference profile refuses the bare id — try the profile-prefixed form.',
	throttled: 'Retry. The service is reachable and the credential authenticated.',
	service: 'Nothing to do here; the service could not serve the request. Retry later.',
	'unreachable-service':
		'Nothing was learned about the service. Check network reachability of the Bedrock endpoint for this region before changing any credential.',
}

/** The reason an AWS failure implies; "nothing was learned" when unrecognised. */
export function reasonForError(err: unknown): BedrockHealthReason {
	// Read off the object rather than gated on an instanceof check. Bedrock
	// reports several failures as members of the stream's output union, and a
	// deserialiser that hands one back as a plain shape would otherwise fall all
	// the way through to "nothing was learned" while naming its own class.
	const raw = (err as { name?: unknown } | null)?.name
	const name = typeof raw === 'string' ? raw : ''
	for (const [pattern, reason] of REASON_BY_EXCEPTION) {
		if (pattern.test(name)) return reason
	}

	// A region that was never configured also never leaves the machine, and the
	// AWS SDK reports it as a plain `Error`, so there is no class to match.
	const message = err instanceof Error ? err.message : String(err)
	if (/region is missing|missing region/i.test(message)) return 'no-credentials'

	return 'unreachable-service'
}

/**
 * Build the report for a failure.
 *
 * The vendor error's message is taken from `providerVendorError` rather than
 * from `err.message`, and that is not stylistic. AWS builds an exception
 * message from the response body, so a credential the service echoed back is
 * already inside `err.message` before this code sees it; `providerVendorError`
 * is the one place in this estate that strips it. The class name is read off
 * the raw error first — a name is not a body — and then the raw error is
 * dropped.
 */
export function reportForError(
	err: unknown,
	model: string,
	durationMs: number,
): BedrockHealthReport {
	const reason = reasonForError(err)
	const safe = providerVendorError({ providerId: 'bedrock', error: err })
	return {
		status: STATUS_BY_REASON[reason],
		reason,
		model,
		message: safe.message,
		...(REMEDIATION_BY_REASON[reason] ? { remediation: REMEDIATION_BY_REASON[reason] } : {}),
		durationMs,
	}
}

/** The report for a reason that needs no vendor error to describe it. */
export function report(
	reason: BedrockHealthReason,
	message: string,
	extra: { readonly model?: string; readonly durationMs?: number } = {},
): BedrockHealthReport {
	return {
		status: STATUS_BY_REASON[reason],
		reason,
		message,
		...(extra.model !== undefined ? { model: extra.model } : {}),
		...(REMEDIATION_BY_REASON[reason] ? { remediation: REMEDIATION_BY_REASON[reason] } : {}),
		...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
	}
}
