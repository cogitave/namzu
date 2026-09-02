/**
 * Narrower rosters from a wider one.
 *
 * A delegate that can only look, or a file-defined agent with an allowlist,
 * needs a registry that is the parent's minus something — and every host
 * that builds delegates wrote the same two loops. They live here so the
 * predicate for "read-only" is the one the authorization gate and the
 * prompt exemption already use (`isTrustedReadOnly`), not a third reading
 * of the same flag.
 *
 * Both filters INTERSECT: a name in an allowlist that the source does not
 * carry is simply not there. A filter can never widen.
 */

import { ToolRegistry } from '../registry/tool/execute.js'
import type { ToolRegistryContract } from '../types/tool/index.js'
import { isTrustedReadOnly } from './trusted-read-only.js'

/**
 * The tools that declare themselves read-only and are trusted to say so.
 *
 * Decided by `isTrustedReadOnly` with no input, which is each tool's own
 * declaration: a new read-only builtin joins the roster without this file
 * learning its name, and a connected server's tool that merely CLAIMS to be
 * read-only stays out unless its provenance is trusted.
 */
export function filterReadOnlyTools(source: ToolRegistryContract): ToolRegistry {
	const filtered = new ToolRegistry()
	for (const tool of source.getAll()) {
		if (isTrustedReadOnly(tool, undefined)) filtered.register(tool)
	}
	return filtered
}

/** The tools whose names are listed. Names the source does not carry are ignored. */
export function filterToolsNamed(
	source: ToolRegistryContract,
	names: Iterable<string>,
): ToolRegistry {
	const allowed = new Set(names)
	const filtered = new ToolRegistry()
	for (const tool of source.getAll()) {
		if (allowed.has(tool.name)) filtered.register(tool)
	}
	return filtered
}
