import { resolve } from 'node:path'
import { isClearedToolResult } from '../../compaction/tool-result-editing.js'
import { fingerprintContent } from '../../tools/builtins/content-fingerprint.js'
import { WriteFileTool } from '../../tools/builtins/write-file.js'
import type { Message, ToolCall } from '../../types/message/index.js'
import type { FileReadTracker } from '../../types/tool/index.js'

/** Join visible call bodies, successful receipts and this executor's observation ledger. */
export function describeVisibleFileEvidence(
	messages: readonly Message[],
	tracker: FileReadTracker,
	workingDirectory: string,
	sandboxed: boolean,
): string | undefined {
	// Execution-owned witnesses survive transparent wrappers; a name alone proves nothing.
	if (!tracker.writeCallId || !tracker.fingerprint) return
	const calls = new Map<string, ToolCall | null>()
	const results = new Map<string, Message | null>()
	for (const message of messages) {
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) {
				calls.set(call.id, calls.has(call.id) ? null : call)
			}
		} else if (message.role === 'tool') {
			results.set(message.toolCallId, results.has(message.toolCallId) ? null : message)
		}
	}
	const files = new Map<string, { path: string; bodyInCall: string; observedFingerprint: string }>()
	for (const [id, call] of calls) {
		const receipt = results.get(id)
		if (
			!call ||
			call.function.name !== 'write' ||
			call.metadata?.inputTruncated ||
			call.function.arguments.length > 32_000 ||
			id.length > 256 ||
			!receipt ||
			receipt.role !== 'tool' ||
			receipt.isError ||
			typeof receipt.content !== 'string' ||
			isClearedToolResult(receipt.content)
		)
			continue
		try {
			const input = WriteFileTool.inputSchema.safeParse(JSON.parse(call.function.arguments))
			if (!input.success || input.data.path.length > 512) continue
			const body = input.data.content ?? input.data.newStr
			if (typeof body !== 'string') continue
			const key = sandboxed ? input.data.path : resolve(workingDirectory, input.data.path)
			const fingerprint = fingerprintContent(body)
			if (tracker.writeCallId(key) !== id || tracker.fingerprint(key) !== fingerprint) continue
			files.delete(key)
			files.set(key, {
				path: input.data.path,
				bodyInCall: id,
				observedFingerprint: fingerprint,
			})
			if (files.size > 6) files.delete(files.keys().next().value as string)
		} catch {
			// Malformed retained inputs or a custom tracker cannot establish evidence.
		}
	}
	if (files.size === 0) return
	return `Visible file evidence (this request only): each complete body remains in the named successful write call and matches the latest conversation observation. Reuse that body for a targeted edit; a read solely to recall it is unnecessary. This is NOT a fresh disk check. Built-in edit/write still compare the disk body at mutation admission and refuse observed drift; on refusal inspect the current file and replan. Missing entries establish nothing.\n${JSON.stringify([...files.values()])}`
}
