/**
 * A folder's own `worktree_create` hook, in a folder nobody has trusted.
 *
 * A folder's hooks run only once a person trusted it. A worktree command in an
 * untrusted folder therefore never attaches the hook the folder declares, and
 * the kernel would make a Git worktree, which is the very thing the hook was
 * written to replace. This file finds out that such a hook exists so the
 * command can refuse instead.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_CONFIG_FILES = ['namzu.config.json', 'namzu.config.local.json'] as const

const isCreateEventName = (key: string): boolean =>
	key.replace(/[_\-\s]/g, '').toLowerCase() === 'worktreecreate'

function declaresCreateHook(parsed: unknown): boolean {
	if (parsed === null || typeof parsed !== 'object') return false
	const hooks = (parsed as { hooks?: unknown }).hooks
	if (hooks === null || typeof hooks !== 'object') return false
	for (const [key, value] of Object.entries(hooks)) {
		if (!isCreateEventName(key)) continue
		if (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined) return true
	}
	return false
}

/**
 * The project files in `cwd` that declare a `worktree_create` hook. A file that
 * cannot be parsed counts when its text names the event at all: a hook that
 * tried to say something we cannot read is not a reason to do without it.
 */
export function projectFilesDeclaringWorktreeCreate(cwd: string): string[] {
	const found: string[] = []
	for (const name of PROJECT_CONFIG_FILES) {
		let text: string
		try {
			text = readFileSync(join(cwd, name), 'utf8')
		} catch {
			continue
		}
		try {
			if (declaresCreateHook(JSON.parse(text.replace(/^﻿/, '')))) found.push(name)
		} catch {
			if (/worktree[_\-\s]?create/i.test(text)) found.push(name)
		}
	}
	return found
}
