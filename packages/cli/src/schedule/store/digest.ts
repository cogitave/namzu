/**
 * A digest of the project configuration that runs code, pinned when a job is
 * confirmed.
 *
 * `namzu.config.json` in the job's folder is repository content: a `git pull`
 * in one run can add a hook, a tool server, a plugin or a permission before the
 * next. A folder check compares a path; this compares what is IN it. The
 * sections that execute code or change what may run are hashed, plus the
 * project's command files and plugin bundles. A change gives the next run
 * `blocked-config` until the operator confirms the job again.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ProjectDigest } from '../types.js'
import { stableStringify } from './jobs.js'

export const DIGESTED_SECTIONS = [
	'hooks',
	'mcpServers',
	'plugins',
	'permissions',
	'permissionChecks',
	'sandbox',
	'web',
	'additionalDirectories',
	'profiles',
] as const

const MAX_FILES = 2_000
const MAX_BYTES = 32 * 1024 * 1024

function sha(text: string | Buffer): string {
	return createHash('sha256').update(text).digest('hex')
}

function configSections(folder: string): string {
	let raw: string
	try {
		raw = readFileSync(join(folder, 'namzu.config.json'), 'utf8')
	} catch {
		return 'absent'
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const picked: Record<string, unknown> = {}
		for (const key of DIGESTED_SECTIONS) if (key in parsed) picked[key] = parsed[key]
		// A file that declares none of these runs nothing, like no file at all.
		return Object.keys(picked).length === 0 ? 'absent' : sha(stableStringify(picked))
	} catch {
		// Unparseable is a state too: hash the bytes, so fixing it is a change.
		return `unparsed:${sha(raw)}`
	}
}

function treeDigest(root: string): string {
	const hash = createHash('sha256')
	let files = 0
	let bytes = 0
	let overflow = false
	const visit = (dir: string): void => {
		let entries: string[]
		try {
			entries = readdirSync(dir).sort()
		} catch {
			return
		}
		for (const name of entries) {
			if (files >= MAX_FILES) {
				overflow = true
				return
			}
			const path = join(dir, name)
			let st: ReturnType<typeof lstatSync>
			try {
				st = lstatSync(path)
			} catch {
				continue
			}
			const rel = relative(root, path).replaceAll('\\', '/')
			if (st.isSymbolicLink()) {
				hash.update(`link:${rel}\0`)
				continue
			}
			if (st.isDirectory()) {
				if (name === 'node_modules' || name === '.git') {
					hash.update(`dir:${rel}:${st.mtimeMs}\0`)
					continue
				}
				visit(path)
				continue
			}
			if (!st.isFile()) continue
			files++
			if (bytes + st.size > MAX_BYTES) {
				overflow = true
				hash.update(`file:${rel}:${st.size}:${st.mtimeMs}\0`)
				continue
			}
			bytes += st.size
			hash.update(`file:${rel}\0`)
			try {
				hash.update(readFileSync(path))
			} catch {
				hash.update('unreadable')
			}
			hash.update('\0')
		}
	}
	try {
		if (!lstatSync(root).isDirectory()) return 'absent'
	} catch {
		return 'absent'
	}
	visit(root)
	return `${overflow ? 'partial:' : ''}${hash.digest('hex')}`
}

/** The digest of `folder`'s code-executing project configuration now. */
export function computeProjectDigest(folder: string): ProjectDigest {
	return {
		algo: 'sha256',
		files: {
			'namzu.config.json': configSections(folder),
			'.namzu/commands': treeDigest(join(folder, '.namzu', 'commands')),
			'.namzu/plugins': treeDigest(join(folder, '.namzu', 'plugins')),
		},
		sections: [...DIGESTED_SECTIONS],
	}
}

/** The entries that differ between two digests, by relative path. */
export function projectDigestChanges(pinned: ProjectDigest, now: ProjectDigest): string[] {
	const keys = new Set([...Object.keys(pinned.files), ...Object.keys(now.files)])
	return [...keys].filter((k) => pinned.files[k] !== now.files[k]).sort()
}
