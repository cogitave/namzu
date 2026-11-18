/**
 * What kind of thing a file is, as a person names it. One table for the window (cards, the
 * Outputs pane) and for the main process (which files count as made, which may open in the
 * system's own program), so the two never disagree.
 */

export type OutputCardKind =
	| 'page'
	| 'document'
	| 'image'
	| 'spreadsheet'
	| 'presentation'
	| 'code'
	| 'file'

interface Format {
	kind: OutputCardKind
	/** The format as it reads on the kind line. */
	label: string
}

const FORMATS: Record<string, Format> = {
	html: { kind: 'page', label: 'HTML' },
	htm: { kind: 'page', label: 'HTML' },
	md: { kind: 'document', label: 'Markdown' },
	markdown: { kind: 'document', label: 'Markdown' },
	txt: { kind: 'document', label: 'Text' },
	rtf: { kind: 'document', label: 'Rich text' },
	pdf: { kind: 'document', label: 'PDF' },
	doc: { kind: 'document', label: 'Word' },
	docx: { kind: 'document', label: 'Word' },
	odt: { kind: 'document', label: 'OpenDocument' },
	png: { kind: 'image', label: 'PNG' },
	jpg: { kind: 'image', label: 'JPEG' },
	jpeg: { kind: 'image', label: 'JPEG' },
	gif: { kind: 'image', label: 'GIF' },
	webp: { kind: 'image', label: 'WebP' },
	svg: { kind: 'image', label: 'SVG' },
	csv: { kind: 'spreadsheet', label: 'CSV' },
	tsv: { kind: 'spreadsheet', label: 'TSV' },
	xls: { kind: 'spreadsheet', label: 'Excel' },
	xlsx: { kind: 'spreadsheet', label: 'Excel' },
	ods: { kind: 'spreadsheet', label: 'OpenDocument' },
	ppt: { kind: 'presentation', label: 'PowerPoint' },
	pptx: { kind: 'presentation', label: 'PowerPoint' },
	odp: { kind: 'presentation', label: 'OpenDocument' },
	ts: { kind: 'code', label: 'TypeScript' },
	tsx: { kind: 'code', label: 'TypeScript' },
	js: { kind: 'code', label: 'JavaScript' },
	jsx: { kind: 'code', label: 'JavaScript' },
	mjs: { kind: 'code', label: 'JavaScript' },
	cjs: { kind: 'code', label: 'JavaScript' },
	py: { kind: 'code', label: 'Python' },
	rs: { kind: 'code', label: 'Rust' },
	go: { kind: 'code', label: 'Go' },
	java: { kind: 'code', label: 'Java' },
	c: { kind: 'code', label: 'C' },
	h: { kind: 'code', label: 'C' },
	cpp: { kind: 'code', label: 'C++' },
	cs: { kind: 'code', label: 'C#' },
	rb: { kind: 'code', label: 'Ruby' },
	php: { kind: 'code', label: 'PHP' },
	sh: { kind: 'code', label: 'Shell' },
	sql: { kind: 'code', label: 'SQL' },
	css: { kind: 'code', label: 'CSS' },
	json: { kind: 'code', label: 'JSON' },
	yaml: { kind: 'code', label: 'YAML' },
	yml: { kind: 'code', label: 'YAML' },
	toml: { kind: 'code', label: 'TOML' },
	xml: { kind: 'code', label: 'XML' },
}

export function extensionOf(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function outputCardKind(path: string): OutputCardKind {
	return FORMATS[extensionOf(path)]?.kind ?? 'file'
}

const KIND_WORDS: Record<OutputCardKind, string> = {
	page: 'Page',
	document: 'Document',
	image: 'Image',
	spreadsheet: 'Spreadsheet',
	presentation: 'Presentation',
	code: 'Code',
	file: 'File',
}
export const outputKindWord = (kind: OutputCardKind): string => KIND_WORDS[kind]

/** "Markdown", "PNG", "TypeScript"; an unknown extension reads in capitals, none reads as nothing. */
export function outputFormatLabel(path: string): string {
	const ext = extensionOf(path)
	if (!ext) return ''
	return FORMATS[ext]?.label ?? (ext.length <= 5 ? ext.toUpperCase() : '')
}

/**
 * Files a shell command or a tool can make that a person would call a result: pages, documents,
 * pictures, sheets and slides. Source code, data and logs a build leaves behind are not results.
 */
export function isMadeFileKind(path: string): boolean {
	const kind = outputCardKind(path)
	return (
		kind === 'page' ||
		kind === 'document' ||
		kind === 'image' ||
		kind === 'spreadsheet' ||
		kind === 'presentation'
	)
}

/**
 * Whether the system's own program may open the file. Only the result kinds above: a program, a
 * script or a shortcut is never started from a card.
 */
export const mayOpenWithSystem = (path: string): boolean => isMadeFileKind(path)

/** Kinds whose text a person can copy from a card. */
export function isTextOutput(path: string): boolean {
	const ext = extensionOf(path)
	const kind = outputCardKind(path)
	if (kind === 'code') return true
	return ['html', 'htm', 'md', 'markdown', 'txt', 'csv', 'tsv', 'svg'].includes(ext)
}
