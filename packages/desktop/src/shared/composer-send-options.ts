import type { DesktopSendOptions } from './protocol.js'

/** Default only after main has established conversation ownership. */
export function resolveComposerSendOptions(
	options: Omit<DesktopSendOptions, 'attachmentIds'> | undefined,
	palId?: string,
): Omit<DesktopSendOptions, 'attachmentIds'> {
	return {
		...(options?.effort ? { effort: options.effort } : {}),
		permissionMode: options?.permissionMode ?? (palId ? 'auto' : 'prompt'),
	}
}
