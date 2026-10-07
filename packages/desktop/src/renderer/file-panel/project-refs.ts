import type { ProjectLinkResolution } from '../../shared/protocol.js'

/** The host accepts at most this many references per call. */
export const MAX_REFS = 200
const MAX_REF = 300

/** Fenced blocks are code samples, not references to this project. */
function withoutFences(markdown: string): string {
	const kept: string[] = []
	let fence: string | undefined
	for (const line of markdown.split('\n')) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
		if (fence === undefined) {
			if (marker) fence = marker
			else kept.push(line)
		} else if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
	}
	return kept.join('\n')
}

function hasControl(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || code === 127) return true
	}
	return false
}

const WEB_OR_ANCHOR = /^(?:https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i

/** What a reply's link target names, or undefined when it is not something this project could hold. */
export function linkRef(href: string | undefined): string | undefined {
	if (!href) return undefined
	let value = href.trim()
	if (!value || value.length > MAX_REF * 2 || WEB_OR_ANCHOR.test(value)) return undefined
	if (/^file:\/\//i.test(value)) return hasControl(value) ? undefined : value
	try {
		value = decodeURIComponent(value)
	} catch {
		// Keep the text as written.
	}
	if (value.length > MAX_REF || hasControl(value) || value.startsWith('-')) return undefined
	// A drive letter is a path; any other scheme is not.
	if (SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined
	return value
}

/** An inline code span that reads as a file: a separator, or a name with an extension. */
export function codeRef(text: string | undefined): string | undefined {
	if (!text || text.length > MAX_REF || /\s/.test(text) || hasControl(text)) return undefined
	if (text.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('//'))
		return undefined
	const body = text.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '')
	if (!/[A-Za-z0-9]/.test(body)) return undefined
	if (/[\\/]/.test(body)) return /[A-Za-z0-9_]\/?$|\.[A-Za-z0-9]+$/.test(body) ? text : undefined
	return /^[\w@.-]*[A-Za-z_][\w@-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(body) ? text : undefined
}

/** Every reference in a settled reply, in order, once each, within the host's per-call cap. */
export function pathCandidates(markdown: string): string[] {
	const text = withoutFences(markdown)
	const found = new Set<string>()
	const add = (ref: string | undefined) => {
		if (ref && found.size < MAX_REFS) found.add(ref)
	}
	for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g))
		add(linkRef(match[1]))
	for (const match of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) add(codeRef(match[1]))
	return [...found]
}

/**
 * A path inside a Markdown file's own folder, normalised against it. Anything that leaves the
 * project root, names a scheme or is not a plain relative reference gives undefined.
 */
export function relativeProjectPath(baseFile: string, href: string): string | undefined {
	const target = href.split(/[?#]/)[0] ?? ''
	if (!target || hasControl(target) || WEB_OR_ANCHOR.test(target) || SCHEME.test(target))
		return undefined
	let decoded = target
	try {
		decoded = decodeURIComponent(target)
	} catch {
		// Keep the text as written.
	}
	if (/^[\\/]|^[a-z]:/i.test(decoded) || decoded.includes('\\')) return undefined
	const stack = baseFile.split('/').slice(0, -1)
	for (const part of decoded.split('/')) {
		if (part === '' || part === '.') continue
		if (part === '..') {
			if (stack.length === 0) return undefined
			stack.pop()
		} else stack.push(part)
	}
	return stack.length ? stack.join('/') : undefined
}

export function isMarkdownPath(path: string): boolean {
	return /\.(?:md|markdown)$/i.test(path)
}

export function baseNameOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1)
}

export function parentOf(path: string): string {
	const index = path.lastIndexOf('/')
	return index < 0 ? '' : path.slice(0, index)
}

/** A resolved reply link: the host's answer for one reference. */
export type ResolvedRefs = ReadonlyMap<string, ProjectLinkResolution & { path: string }>

type Call = (projectId: string, refs: string[]) => Promise<ProjectLinkResolution[]>

/**
 * Remembers what the host said about each reference so a reply is asked about once, and a
 * reference already answered (either way) is not asked again until `negativeTtl` has passed,
 * since a file the reply is about to create may exist a moment later.
 */
export function createLinkCache(call: Call, now: () => number = Date.now, negativeTtl = 60_000) {
	const answers = new Map<string, { value: ProjectLinkResolution | null; at: number }>()
	const inflight = new Map<string, Promise<void>>()
	const key = (projectId: string, ref: string) => `${projectId}\0${ref}`
	const fresh = (entry: { value: unknown; at: number } | undefined) =>
		!!entry && (entry.value !== null || now() - entry.at < negativeTtl)
	// Replies settle in a burst when a long conversation opens; whatever is asked within one
	// tick travels together, so a history costs a few host calls and not one per message.
	let queued = new Map<string, Set<string>>()
	let tick: Promise<void> | undefined
	const send = (projectId: string, batch: string[]) =>
		call(projectId, batch).then(
			(results) => {
				const at = now()
				const byRef = new Map(results.map((result) => [result.ref, result]))
				for (const ref of batch) {
					const hit = byRef.get(ref)
					answers.set(key(projectId, ref), { value: hit?.path ? hit : null, at })
				}
			},
			() => {
				// A failed call is not an answer; the next settled message asks again.
			},
		)
	const flush = async () => {
		const taken = queued
		queued = new Map()
		tick = undefined
		const calls: Promise<void>[] = []
		for (const [projectId, refs] of taken) {
			const all = [...refs]
			for (let at = 0; at < all.length; at += MAX_REFS)
				calls.push(send(projectId, all.slice(at, at + MAX_REFS)))
		}
		await Promise.all(calls)
	}
	return {
		async resolve(projectId: string, refs: readonly string[]): Promise<ResolvedRefs> {
			const missing = refs.filter(
				(ref) => !fresh(answers.get(key(projectId, ref))) && !inflight.has(key(projectId, ref)),
			)
			if (missing.length > 0) {
				const set = queued.get(projectId) ?? new Set<string>()
				for (const ref of missing) set.add(ref)
				queued.set(projectId, set)
				if (!tick) tick = Promise.resolve().then(flush)
				const pending = tick
				for (const ref of missing) inflight.set(key(projectId, ref), pending)
				void pending.then(() => {
					for (const ref of missing)
						if (inflight.get(key(projectId, ref)) === pending) inflight.delete(key(projectId, ref))
				})
			}
			await Promise.all(refs.map((ref) => inflight.get(key(projectId, ref))))
			const result = new Map<string, ProjectLinkResolution & { path: string }>()
			for (const ref of refs) {
				const entry = answers.get(key(projectId, ref))
				if (entry?.value?.path) result.set(ref, { ...entry.value, path: entry.value.path })
			}
			return result
		},
	}
}
