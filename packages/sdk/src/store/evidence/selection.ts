import { z } from 'zod'
import { digest } from './format.js'

/** Host-selected search exclusion, never an authorization rule or inferred provenance. */
export const evidenceExclusionsSchema = z
	.array(z.string().min(1).max(256))
	.max(16)
	.default([])
	.transform((names) => [...new Set(names)].sort())

export function evidenceExclusionsKey(
	names: readonly string[],
	excludeDerivedSummaries = false,
): string | undefined {
	if (excludeDerivedSummaries)
		return digest(JSON.stringify({ tools: names, derivedSummaries: true }))
	return names.length ? digest(JSON.stringify(names)) : undefined
}

export function excludesSuccessfulTool(
	entry: { toolName?: string; isError?: boolean },
	names: readonly string[],
): boolean {
	return entry.isError === false && entry.toolName !== undefined && names.includes(entry.toolName)
}
