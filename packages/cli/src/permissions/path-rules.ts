/**
 * File rules that mean a path.
 *
 * A pattern written under `read`, `edit` and the other file tools is a path
 * glob, not text to find in the serialised call. It is resolved to an absolute
 * glob and the call's path is resolved the same way before they meet, so
 * `./.env`, `.env` and `/work/project/.env` are one rule and one file.
 *
 * Where a pattern starts decides what it is relative to:
 *
 * - `//path`   an absolute path (`//etc/hosts` is `/etc/hosts`)
 * - `~/path`   the home directory
 * - `/path`    the project folder
 * - `./path`   the working folder (so does a pattern with no prefix)
 *
 * `*` stays inside one folder, `**` crosses folders, a dot file needs no
 * special spelling, and a rule on a folder covers everything inside it.
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import type { AuthorizationRule } from '@namzu/sdk'
import { minimatch } from 'minimatch'
import type { PermissionEffect } from './rules.js'

/** The execution directory for call paths, separate from the settings file's rule root. */
export interface PathRuleContext {
	readonly cwd?: string
	readonly home?: string
	/** Directory of the settings file that authored the patterns. */
	readonly ruleRoot?: string
}

/**
 * The tools a path rule written under a name decides, by the tool's own
 * `pathArgument` (`path`). A rule on `read` also covers the search and listing
 * tools, and a rule on `edit` also covers `write`, so a refusal of a file for
 * one cannot be walked around with its sibling.
 */
const PATH_RULE_TOOLS: Readonly<Record<string, readonly string[]>> = {
	read: ['read', 'grep', 'glob', 'ls'],
	edit: ['edit', 'write'],
	write: ['write'],
	grep: ['grep'],
	glob: ['glob'],
	ls: ['ls'],
}

export function isPathRuleTool(tool: string): boolean {
	return Object.hasOwn(PATH_RULE_TOOLS, tool)
}

const PATH_ARGUMENT = 'path'
const WINDOWS = process.platform === 'win32'

function slashed(value: string): string {
	return value.replaceAll('\\', '/')
}

function realOf(path: string): string {
	try {
		return slashed(realpathSync(path))
	} catch {
		return slashed(path)
	}
}

/** The path as it is on disk: the deepest part that exists is resolved, the rest is kept. */
function physical(path: string): string {
	let current = path
	const tail: string[] = []
	for (;;) {
		try {
			return slashed(join(realpathSync(current), ...tail))
		} catch {
			const parent = dirname(current)
			if (parent === current) return slashed(path)
			tail.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''))
			current = parent
		}
	}
}

function expandHome(value: string, home: string): string {
	if (value === '~') return home
	if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
	return value
}

/** Where a rule's pattern points, as an absolute glob under each base spelling. */
function globsOf(pattern: string, base: { cwd: string; home: string }): string[] {
	const spell = (cwd: string, home: string): string => {
		const text = slashed(pattern.trim())
		if (text.startsWith('//')) return posix.normalize(text.slice(1))
		if (text === '~' || text.startsWith('~/')) {
			return posix.join(minimatch.escape(slashed(home)), text.slice(2))
		}
		if (text.startsWith('/') && !/^\/[A-Za-z]:/.test(text)) {
			return posix.join(minimatch.escape(slashed(cwd)), text.slice(1))
		}
		if (/^[A-Za-z]:\//.test(text)) return posix.normalize(text)
		return posix.join(minimatch.escape(slashed(cwd)), text)
	}
	const spellings = new Set<string>([spell(base.cwd, base.home)])
	spellings.add(spell(realOf(base.cwd), realOf(base.home)))
	return [...spellings].map((glob) => (glob.length > 1 ? glob.replace(/\/+$/, '') : glob))
}

function candidatesOf(value: string, base: { cwd: string; home: string }): string[] {
	const logical = slashed(resolve(base.cwd, expandHome(value.trim(), base.home)))
	const onDisk = physical(logical)
	return onDisk === logical ? [logical] : [logical, onDisk]
}

/** Whether the path, or a folder above it, is named by the glob. */
function covers(glob: string, path: string): boolean {
	const options = {
		dot: true,
		nocase: WINDOWS,
		nonegate: true,
		nocomment: true,
	}
	let current = path
	for (;;) {
		// A subtree pattern also names its root directory. minimatch otherwise
		// needs a trailing slash for `src/**` to match `src`, which would make
		// discovery on that directory miss its most specific permission rule.
		if (
			minimatch(current, glob, options) ||
			(glob.endsWith('/**') && minimatch(current, glob.slice(0, -3), options))
		)
			return true
		const parent = posix.dirname(current)
		if (parent === current) return false
		current = parent
	}
}

/**
 * One path rule as a kernel rule. A deny or an ask applies if the path, or the
 * file it resolves to through a link, is named; an allow only if every
 * spelling of it is, so a link inside an allowed folder cannot lead out of it.
 */
export function pathRule(
	tool: string,
	pattern: string,
	effect: PermissionEffect,
	context: PathRuleContext = {},
): AuthorizationRule {
	const names = [...(PATH_RULE_TOOLS[tool] ?? [tool])]
	const decision = effect === 'ask' ? 'review' : effect
	// Capture once: a later process.chdir must not retarget an existing policy.
	const base = {
		cwd: resolve(context.cwd ?? process.cwd()),
		home: context.home ?? homedir(),
	}
	const ruleBase = { ...base, cwd: context.ruleRoot ?? base.cwd }
	const verdict = (toolName: string, input: unknown) => {
		if (!names.includes(toolName)) return undefined
		if (typeof input !== 'object' || input === null) return undefined
		const written = (input as Record<string, unknown>)[PATH_ARGUMENT]
		const value =
			(written === undefined || written === '') && ['grep', 'glob', 'ls'].includes(toolName)
				? '.'
				: written
		if (typeof value !== 'string' || value === '') return undefined
		const globs = globsOf(pattern, ruleBase)
		const candidates = candidatesOf(value, base)
		const named = (path: string) => globs.some((glob) => covers(glob, path))
		const hit = decision === 'allow' ? candidates.every(named) : candidates.some(named)
		return hit ? candidates[0] : undefined
	}
	const verb =
		decision === 'deny' ? 'denied' : decision === 'review' ? 'sent for review' : 'allowed'
	return {
		type: 'predicate',
		description: `${verb} by a path rule for ${names.join(', ')}: ${pattern}`,
		decide: (call) => (verdict(call.toolName, call.toolInput) === undefined ? null : decision),
		describe: (call) => {
			const path = verdict(call.toolName, call.toolInput)
			return path === undefined
				? `${verb} by a path rule: ${pattern}`
				: `${verb} because ${path} matches the path rule ${pattern} (this rule applies to ${names.join(', ')})`
		},
	}
}

/**
 * Search tools authorize their root once, not each file they visit. Until their
 * execution surface supports a per-entry policy, refuse an ancestor search that
 * could expose a restricted descendant. This deliberately ignores include/glob
 * filters and ls depth: a caller can narrow the root or read a safe file instead.
 * No disk walk is used, so a missing file created after review is protected too.
 */
export function descendantPathBoundary(
	tool: string,
	pattern: string,
	effect: Exclude<PermissionEffect, 'allow'>,
	context: PathRuleContext = {},
): AuthorizationRule | undefined {
	const names = (PATH_RULE_TOOLS[tool] ?? []).filter((name) =>
		['grep', 'glob', 'ls'].includes(name),
	)
	if (names.length === 0) return undefined
	const base = {
		cwd: resolve(context.cwd ?? process.cwd()),
		home: context.home ?? homedir(),
	}
	const ruleBase = { ...base, cwd: context.ruleRoot ?? base.cwd }
	const decision = effect === 'ask' ? 'review' : 'deny'
	return {
		type: 'predicate',
		description: `search may expose a descendant restricted by ${tool}(${pattern}); narrow the search path`,
		decide: (call) => {
			if (!names.includes(call.toolName)) return null
			if (typeof call.toolInput !== 'object' || call.toolInput === null) return null
			const written = (call.toolInput as Record<string, unknown>)[PATH_ARGUMENT]
			const value = written === undefined || written === '' ? '.' : written
			if (typeof value !== 'string') return null
			const globs = globsOf(pattern, ruleBase)
			const candidates = candidatesOf(value, base)
			// A root directly named by this rule is decided by ordinary specificity
			// (which may allow a narrower subtree). This guard covers only ancestors.
			const exposes = candidates.some((candidate) =>
				globs.some(
					(glob) =>
						!covers(glob, candidate) &&
						minimatch(candidate, glob, {
							dot: true,
							nocase: WINDOWS,
							nonegate: true,
							nocomment: true,
							partial: true,
						}),
				),
			)
			return exposes ? decision : null
		},
	}
}
