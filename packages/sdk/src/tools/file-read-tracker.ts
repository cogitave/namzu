import type { FileReadTracker } from '../types/tool/index.js'
import { fingerprintContent } from './builtins/content-fingerprint.js'

/** Host-owned observation ledger. Share only across turns of the same conversation and filesystem. */
export function createFileReadTracker(): FileReadTracker {
	const paths = new Set<string>()
	const fingerprints = new Map<string, string>()
	const writes = new Map<string, string>()
	return {
		recordRead(key, content, fullWriteCallId) {
			paths.add(key)
			const next = content === undefined ? undefined : fingerprintContent(content)
			if (next === undefined || next !== fingerprints.get(key)) writes.delete(key)
			if (next !== undefined) fingerprints.set(key, next)
			else fingerprints.delete(key)
			if (next !== undefined && fullWriteCallId) writes.set(key, fullWriteCallId)
		},
		hasRead: (key) => paths.has(key),
		fingerprint: (key) => fingerprints.get(key),
		writeCallId: (key) => writes.get(key),
	}
}
