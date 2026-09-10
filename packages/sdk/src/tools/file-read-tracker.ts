import type { FileReadTracker } from '../types/tool/index.js'
import { fingerprintContent } from './builtins/content-fingerprint.js'

/** Host-owned observation ledger. Share only across turns of the same conversation and filesystem. */
export function createFileReadTracker(): FileReadTracker {
	const paths = new Set<string>()
	const fingerprints = new Map<string, string>()
	return {
		recordRead(key, content) {
			paths.add(key)
			if (content !== undefined) fingerprints.set(key, fingerprintContent(content))
		},
		hasRead: (key) => paths.has(key),
		fingerprint: (key) => fingerprints.get(key),
	}
}
