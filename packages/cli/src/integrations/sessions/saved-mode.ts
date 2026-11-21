import type { SessionRecord } from '@namzu/sdk'

/**
 * The permission mode a conversation last saved: the newest `session_updated`
 * that names one. Only plan mode is ever saved (and cleared again when plan
 * mode is left), see `recordPermissionMode` in `store.ts`.
 */
export function savedPermissionMode(
	records: readonly SessionRecord[] | undefined,
): string | undefined {
	let saved: string | undefined
	for (const record of records ?? []) {
		if (record.type === 'session_updated' && record.approvalPolicy !== undefined) {
			saved = record.approvalPolicy
		}
	}
	return saved
}
