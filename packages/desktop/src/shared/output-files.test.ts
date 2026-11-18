import { describe, expect, it } from 'vitest'
import {
	extensionOf,
	isMadeFileKind,
	isTextOutput,
	mayOpenWithSystem,
	outputCardKind,
	outputFormatLabel,
	outputKindWord,
} from './output-files.js'
import { previewLine } from './output-preview-line.js'

describe('output kinds', () => {
	it('names a file by what it is', () => {
		expect(outputKindWord(outputCardKind('a/report.MD'))).toBe('Document')
		expect(outputKindWord(outputCardKind('index.html'))).toBe('Page')
		expect(outputKindWord(outputCardKind('c:\\x\\chart.PNG'))).toBe('Image')
		expect(outputKindWord(outputCardKind('main.ts'))).toBe('Code')
		expect(outputKindWord(outputCardKind('data.xlsx'))).toBe('Spreadsheet')
		expect(outputKindWord(outputCardKind('deck.pptx'))).toBe('Presentation')
		expect(outputKindWord(outputCardKind('LICENSE'))).toBe('File')
	})
	it('reads a format, and says nothing for a name with no extension', () => {
		expect(outputFormatLabel('a.md')).toBe('Markdown')
		expect(outputFormatLabel('a.ts')).toBe('TypeScript')
		expect(outputFormatLabel('a.xyz')).toBe('XYZ')
		expect(outputFormatLabel('a.verylongext')).toBe('')
		expect(outputFormatLabel('Makefile')).toBe('')
		expect(extensionOf('.gitignore')).toBe('')
	})
	it('lets a shell result count, but not source, and never opens a program with the system', () => {
		expect(isMadeFileKind('report.pdf')).toBe(true)
		expect(isMadeFileKind('src/app.ts')).toBe(false)
		expect(isMadeFileKind('build.log')).toBe(false)
		expect(mayOpenWithSystem('setup.exe')).toBe(false)
		expect(mayOpenWithSystem('run.sh')).toBe(false)
		expect(mayOpenWithSystem('link.lnk')).toBe(false)
		expect(mayOpenWithSystem('report.docx')).toBe(true)
		expect(isTextOutput('a.csv')).toBe(true)
		expect(isTextOutput('a.png')).toBe(false)
	})
})

describe('the preview line', () => {
	it('takes the first heading of a document, past front matter and fences', () => {
		expect(previewLine('a.md', '---\ntitle: x\n---\n\n# **Plan** for [May](x.md)\ntext')).toBe(
			'Plan for May',
		)
		expect(previewLine('a.md', '```\ncode\n```\nFirst sentence.')).toBe('First sentence.')
	})
	it('takes the first line of code that is not a comment', () => {
		expect(previewLine('a.ts', '// header\n/* x */\n\nexport const a = 1\n')).toBe(
			'export const a = 1',
		)
		expect(previewLine('a.py', '#!/usr/bin/env python\n# note\nimport os')).toBe('import os')
	})
	it('says nothing for a page, a picture or an empty file, and clips a long line', () => {
		expect(previewLine('a.html', '<h1>x</h1>')).toBeUndefined()
		expect(previewLine('a.md', '\n\n')).toBeUndefined()
		expect(previewLine('a.md', 'x'.repeat(500))?.length).toBe(140)
	})
})
