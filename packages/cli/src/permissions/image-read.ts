/**
 * May a pasted or dropped image file be read?
 *
 * A path in a paste is a file read the operator asked for, but it is still the
 * CLI reading a file, so it answers to the same policy the `read` tool does:
 * the permission rules decide first (a `deny` or an `ask` on the path refuses
 * it), then the folders the session reaches (the working directory and the
 * ones `/add-dir` added). A path outside them is refused with a sentence that
 * says how to widen the reach, never read and never sent anywhere.
 */

import {
	AuthorizationGate,
	type AuthorizationRule,
	NOOP_LOGGER,
	resolveWithinReal,
} from '@namzu/sdk'

export interface ImageReadPolicyOptions {
	/** The working directory, read at each check. */
	readonly cwd: () => string
	/** The session's added directories, read at each check. */
	readonly additionalDirectories?: () => readonly string[]
	/** The operator's permission rules, read at each check. */
	readonly rules?: () => readonly AuthorizationRule[] | undefined
}

/** `null` when the path may be read, otherwise a plain sentence saying why not. */
export type ImageReadPolicy = (path: string) => Promise<string | null>

export function createImageReadPolicy(options: ImageReadPolicyOptions): ImageReadPolicy {
	return async (path) => {
		const rules = options.rules?.() ?? []
		if (rules.length > 0) {
			const gate = new AuthorizationGate(
				{
					enabled: true,
					rules: [...rules],
					allowReadOnlyTools: false,
					denyDangerousPatterns: false,
					logDecisions: false,
				},
				NOOP_LOGGER,
			)
			const verdict = gate.evaluate({ toolName: 'read', toolInput: { path }, toolDef: undefined })
			if (verdict.matchedRule !== null && verdict.decision === 'deny') {
				return `A permission rule keeps this session from reading ${path}.`
			}
			if (verdict.matchedRule !== null && verdict.decision === 'review') {
				return `A permission rule asks before reading ${path}, so it was not attached. Ask the agent to read it instead, or change the rule.`
			}
		}
		const roots = [options.cwd(), ...(options.additionalDirectories?.() ?? [])]
		for (const root of roots) {
			try {
				await resolveWithinReal(root, path)
				return null
			} catch {
				// Not inside this one; try the next.
			}
		}
		return `${path} is outside the folders this session can read. Add its folder with /add-dir, or copy the image into the project.`
	}
}
