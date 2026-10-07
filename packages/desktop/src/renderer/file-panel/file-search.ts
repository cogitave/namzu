import { type Prepared, go, prepare } from 'fuzzysort'
import { baseNameOf } from './project-refs.js'

export interface PreparedIndex {
	paths: readonly string[]
	prepared: readonly Prepared[]
}

export interface Segment {
	text: string
	match: boolean
}
export interface FileHit {
	path: string
	segments: Segment[]
}

export function prepareIndex(paths: readonly string[]): PreparedIndex {
	return { paths, prepared: paths.map((path) => prepare(path)) }
}

/** The path split into runs, so matched characters render as elements and never as raw HTML. */
export function segmentsOf(target: string, indexes: readonly number[]): Segment[] {
	const hit = new Set(indexes)
	const segments: Segment[] = []
	for (let index = 0; index < target.length; index++) {
		const match = hit.has(index)
		const last = segments[segments.length - 1]
		const char = target[index] ?? ''
		if (last && last.match === match) last.text += char
		else segments.push({ text: char, match })
	}
	return segments
}

/** Best matches first; with no query, the first paths in index order. */
export function searchFiles(index: PreparedIndex, query: string, limit = 50): FileHit[] {
	const text = query.trim()
	if (!text)
		return index.paths
			.slice(0, limit)
			.map((path) => ({ path, segments: [{ text: path, match: false }] }))
	return go(text, index.prepared as Prepared[], { limit }).map((result) => ({
		path: result.target,
		segments: segmentsOf(result.target, result.indexes),
	}))
}

export function directoryOf(path: string): string {
	return path.slice(0, Math.max(0, path.length - baseNameOf(path).length - 1))
}
