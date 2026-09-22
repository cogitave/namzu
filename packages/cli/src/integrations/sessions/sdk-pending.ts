/**
 * SDK values the cutover train declares but has not published yet.
 *
 * `createSessionTextEvidenceSource` is part of the frozen session surface
 * (`store/evidence`, owned by the turn-core stream) and is typed there, but
 * its implementation lands with that stream. Importing the name directly
 * would not compile until then, so it is read through the module namespace
 * here, in one place, and fails by name when absent.
 *
 * At the train tip this file is deleted and its one caller imports
 * `createSessionTextEvidenceSource` from `@namzu/sdk` directly.
 */

import * as sdk from '@namzu/sdk'
import type { SessionEvidenceSourceOptions, SessionTextEvidenceSource } from '@namzu/sdk'

type SessionTextEvidenceFactory = (
	options: SessionEvidenceSourceOptions,
) => SessionTextEvidenceSource

/** The SDK's session-log evidence reader. */
export function createSessionTextEvidenceSource(
	options: SessionEvidenceSourceOptions,
): SessionTextEvidenceSource {
	const factory = (
		sdk as unknown as { createSessionTextEvidenceSource?: SessionTextEvidenceFactory }
	).createSessionTextEvidenceSource
	if (typeof factory !== 'function') {
		throw new Error(
			'This SDK build has no session evidence reader (createSessionTextEvidenceSource).',
		)
	}
	return factory(options)
}
