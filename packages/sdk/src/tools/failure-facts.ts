import type { ToolFacts } from '../types/tool/presentation.js'

/**
 * The kind of failure a thrown filesystem error is, as typed facts for the
 * person's view. Read from the error's `code` and `path`, which Node sets
 * structurally, and never from its message.
 */
export function failureFactsFromError(err: unknown): ToolFacts | undefined {
	if (!err || typeof err !== 'object') return undefined
	const { code, path } = err as { code?: unknown; path?: unknown }
	const subject = typeof path === 'string' ? path : undefined
	const reason =
		code === 'ENOENT'
			? 'not_found'
			: code === 'EACCES' || code === 'EPERM'
				? 'permission_denied'
				: code === 'EISDIR' || code === 'ENOTDIR'
					? 'not_a_file'
					: code === 'EEXIST'
						? 'already_exists'
						: undefined
	if (!reason) return undefined
	return { kind: 'failure', reason, ...(subject ? { subject } : {}) }
}
