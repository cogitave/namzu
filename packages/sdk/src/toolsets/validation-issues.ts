/**
 * Tool-input validation issues as sentences a model can act on.
 *
 * A zod message is written for a developer reading a stack trace:
 * `edits: Too small: expected array to have >=1 items` names neither what to
 * send nor why. A small model that reads it tends to repeat the same call. Each
 * kind of issue a flat tool schema commonly produces is rewritten here to name
 * the field and the fix; anything not recognised keeps its own message, so
 * nothing is lost by this being a short list.
 */

export interface ValidationIssueLike {
	readonly path: readonly PropertyKey[]
	readonly message: string
	readonly code?: string
	readonly origin?: string
	readonly minimum?: number | bigint
	readonly maximum?: number | bigint
	readonly expected?: string
	readonly keys?: readonly string[]
	readonly values?: readonly unknown[]
}

/** `edits.0.old_string` as `edits[0].old_string`, the way a model wrote it. */
export function renderIssuePath(path: readonly PropertyKey[]): string {
	let out = ''
	for (const part of path) {
		if (typeof part === 'number') out += `[${part}]`
		else out += out === '' ? String(part) : `.${String(part)}`
	}
	return out
}

function plural(n: number | bigint, noun: string): string {
	return `${n} ${noun}${n === 1 || n === 1n ? '' : 's'}`
}

function received(message: string): string | undefined {
	return /received (\w+)$/.exec(message)?.[1]
}

/** One issue as one sentence, without a trailing period. */
export function describeValidationIssue(issue: ValidationIssueLike): string {
	const field = renderIssuePath(issue.path)
	const name = field === '' ? 'The input' : `"${field}"`
	const min = issue.minimum
	switch (issue.code) {
		case 'too_small':
			if (issue.origin === 'string' && min !== undefined && Number(min) <= 1) {
				return `${name} must not be empty; send the text itself`
			}
			if (issue.origin === 'string' && min !== undefined) {
				return `${name} is too short; it needs at least ${plural(min, 'character')}`
			}
			if (issue.origin === 'array' && min !== undefined) {
				return `${name} is a list with too few entries; it needs at least ${plural(min, 'entry').replace('entrys', 'entries')}, or leave the field out`
			}
			if (min !== undefined) return `${name} is too small; the smallest accepted is ${min}`
			break
		case 'too_big':
			if (issue.maximum !== undefined) {
				return `${name} is too large; the largest accepted is ${issue.maximum}`
			}
			break
		case 'invalid_type': {
			const got = received(issue.message)
			if (issue.expected !== undefined && got === 'undefined') {
				return `${name} is missing; send it as ${withArticle(issue.expected)}`
			}
			if (issue.expected !== undefined && got !== undefined) {
				return `${name} must be ${withArticle(issue.expected)}, not ${got === 'null' ? 'null' : `a ${got}`}`
			}
			break
		}
		case 'unrecognized_keys':
			if (issue.keys !== undefined && issue.keys.length > 0) {
				const list = issue.keys.map((key) => `"${key}"`).join(', ')
				return `${field === '' ? '' : `${name} has `}${issue.keys.length === 1 ? 'a field' : 'fields'} this tool does not take: ${list}. Remove ${issue.keys.length === 1 ? 'it' : 'them'}`
			}
			break
		case 'invalid_value':
			if (issue.values !== undefined && issue.values.length > 0) {
				return `${name} must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`
			}
			break
	}
	const message = issue.message.replace(/\.+$/, '')
	return field === '' ? message : `${field}: ${message}`
}

function withArticle(type: string): string {
	return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`
}

export function describeValidationIssues(issues: readonly ValidationIssueLike[]): string {
	return issues.map(describeValidationIssue).join('; ')
}
