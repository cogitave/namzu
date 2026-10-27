import { readFile } from 'node:fs/promises'

import type { ToolContext } from '../../types/tool/index.js'
import type { ToolFacts } from '../../types/tool/presentation.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'
import { movedSinceRead, staleFileError } from './content-fingerprint.js'

/**
 * The refusal a file mutation would give for a file that moved on disk since
 * the session read it, asked before a person is.
 *
 * `edit` and `write` refuse such a call when they run. By then the person has
 * already been shown a change and said yes to it, so the answer is asked here
 * too, ahead of the review. It looks at the same body the tool will (the host
 * file, or the sandbox's) and says nothing when it cannot tell: a path that is
 * missing or outside the roots, an unreadable file, or a session that never
 * read the path. Those keep their own answers at run time.
 */
export async function staleBeforeReview(
	context: ToolContext,
	path: string,
	operation: 'edit' | 'write',
): Promise<{ readonly error: string; readonly facts: ToolFacts } | undefined> {
	const tracker = context.fileReadTracker
	if (!tracker) return undefined
	let key: string
	let current: string
	try {
		if (context.sandbox) {
			key = path
			current = (await context.sandbox.readFile(path)).toString('utf-8')
		} else {
			key = await resolveWithinAnyReal(toolRoots(context), path)
			current = await readFile(key, 'utf-8')
		}
	} catch {
		return undefined
	}
	if (!movedSinceRead(tracker, key, current)) return undefined
	tracker.recordDriftObserved?.(key)
	return {
		error: staleFileError(key, operation),
		facts: { kind: 'failure', reason: 'changed_on_disk', subject: key },
	}
}
