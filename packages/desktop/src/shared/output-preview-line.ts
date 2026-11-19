import { extensionOf, outputCardKind } from './output-files.js'

/**
 * The one line a card shows under a document or a piece of code: the first heading or sentence
 * of a document, the first line of code that is not a comment. Read from the start of the file
 * only; blank for anything else.
 */
const MAX = 140

const clip = (text: string): string =>
	text.length > MAX ? `${text.slice(0, MAX - 1).trimEnd()}…` : text

export function previewLine(path: string, head: string): string | undefined {
	const kind = outputCardKind(path)
	if (kind !== 'document' && kind !== 'code') return undefined
	const ext = extensionOf(path)
	if (kind === 'document' && ext !== 'md' && ext !== 'markdown' && ext !== 'txt') return undefined
	let inFence = false
	let inFrontmatter = false
	let first = true
	for (const raw of head.split(/\r?\n/)) {
		const line = raw.trim()
		if (kind === 'document') {
			if (first && line === '---') {
				inFrontmatter = true
				first = false
				continue
			}
			first = false
			if (inFrontmatter) {
				if (line === '---') inFrontmatter = false
				continue
			}
			if (/^(```|~~~)/.test(line)) {
				inFence = !inFence
				continue
			}
			if (inFence || !line) continue
			const text = line
				.replace(/^#{1,6}\s+/, '')
				.replace(/^[-*+]\s+/, '')
				.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
				.replace(/[*_`]/g, '')
				.trim()
			if (text) return clip(text)
			continue
		}
		if (!line) continue
		if (/^(\/\/|#!|#\s|\/\*|\*|<!--)/.test(line) || (ext === 'py' && line.startsWith('#'))) continue
		return clip(line)
	}
	return undefined
}
