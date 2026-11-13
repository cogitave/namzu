/**
 * One grammar of a fenced code block, read the same way by the parser, the two
 * screens, the streaming view and `/copy`.
 */

import { Box, Text, renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { ContentWidth, Markdown } from './Markdown.js'
import { copyTargetsForResponse } from './copy-targets.js'
import { fullscreenMessageRows } from './fullscreen/layout.js'
import { paintRow } from './fullscreen/paint.js'
import type { FsRow } from './fullscreen/rows.js'
import {
	closesFence,
	indentColumns,
	openerLine,
	openingFence,
	stripFenceIndent,
} from './markdown-fence.js'
import { type MdBlock, parseMarkdown } from './markdownParser.js'
import type { TranscriptMessage } from './types.js'

const codeBlocks = (text: string): Extract<MdBlock, { type: 'code' }>[] =>
	parseMarkdown(text).filter((b): b is Extract<MdBlock, { type: 'code' }> => b.type === 'code')

/** Every form a model writes a fence in, with the lines of the code it holds. */
const FORMS: Record<string, { text: string; lang?: string; lines: string[]; indent?: number }> = {
	plain: { text: '```\na\nb\n```', lines: ['a', 'b'] },
	word: { text: '```ts\nconst a = 1\n```', lang: 'ts', lines: ['const a = 1'] },
	plusplus: { text: '```c++\nint x;\n```', lang: 'c++', lines: ['int x;'] },
	hyphen: {
		text: '```objective-c\nNSLog(@"x");\n```',
		lang: 'objective-c',
		lines: ['NSLog(@"x");'],
	},
	session: { text: '```shell-session\n$ ls\n```', lang: 'shell-session', lines: ['$ ls'] },
	sharp: { text: '```f#\nlet x = 1\n```', lang: 'f#', lines: ['let x = 1'] },
	title: {
		text: '```ts title="a.ts" {1,3}\nconst a = 1\n```',
		lang: 'ts',
		lines: ['const a = 1'],
	},
	tilde: { text: '~~~python\nprint(1)\n~~~', lang: 'python', lines: ['print(1)'] },
	four: { text: '````md\n```ts\ninner\n```\n````', lang: 'md', lines: ['```ts', 'inner', '```'] },
	longCloser: { text: '```js\none\n`````', lang: 'js', lines: ['one'] },
	spaces: {
		text: '  ```sh\n  echo a\n    echo b\n  ```',
		lang: 'sh',
		lines: ['echo a', '  echo b'],
		indent: 2,
	},
	listThree: {
		text: '1. Do:\n   ```bash\n   npm i\n   ```',
		lang: 'bash',
		lines: ['npm i'],
		indent: 3,
	},
	deep: {
		text: '- a\n  - b\n    ```sh\n    echo deep\n    ```',
		lang: 'sh',
		lines: ['echo deep'],
		indent: 4,
	},
	open: { text: '```ts\nnot closed yet', lang: 'ts', lines: ['not closed yet'] },
}

describe('the fence grammar', () => {
	it('opens at three or more backticks or tildes with an optional info string', () => {
		expect(openingFence('```')).toMatchObject({ char: '`', length: 3, indent: 0 })
		expect(openingFence('~~~~ts')).toMatchObject({ char: '~', length: 4, lang: 'ts' })
		expect(openingFence('   ```c++ title=x')).toMatchObject({ indent: 3, lang: 'c++' })
		expect(openingFence('``')).toBeNull()
		expect(openingFence('~~')).toBeNull()
		// A backtick in a backtick fence's info string makes the line inline code.
		expect(openingFence('```not a fence```')).toBeNull()
		expect(openingFence('```js `x`')).toBeNull()
		// ...but not in a tilde fence's.
		expect(openingFence('~~~ `x`')).toMatchObject({ char: '~' })
		expect(openingFence('text ```')).toBeNull()
	})

	it('closes at the same character, as long as the opener, with nothing after it', () => {
		const three = openingFence('```') as NonNullable<ReturnType<typeof openingFence>>
		const four = openingFence('````') as NonNullable<ReturnType<typeof openingFence>>
		const tilde = openingFence('~~~') as NonNullable<ReturnType<typeof openingFence>>
		expect(closesFence('```', three)).toBe(true)
		expect(closesFence('`````', three)).toBe(true)
		expect(closesFence('```  ', three)).toBe(true)
		expect(closesFence('```js', three)).toBe(false)
		expect(closesFence('```', four)).toBe(false)
		expect(closesFence('~~~', three)).toBe(false)
		expect(closesFence('```', tilde)).toBe(false)
		expect(closesFence('~~~~', tilde)).toBe(true)
		expect(closesFence('    ```', three)).toBe(false)
		expect(closesFence('   ```', three)).toBe(true)
	})

	it('takes the opener indentation off a content line and nothing else', () => {
		expect(stripFenceIndent('   a', 3)).toBe('a')
		expect(stripFenceIndent('     a', 3)).toBe('  a')
		expect(stripFenceIndent(' a', 3)).toBe('a')
		expect(stripFenceIndent('\ta', 4)).toBe('a')
		expect(indentColumns('\t ')).toBe(5)
		expect(openerLine({ char: '~', length: 4, indent: 2, lang: 'rs' })).toBe('  ~~~~rs')
	})
})

describe('a fenced block is a block in every form', () => {
	for (const [name, form] of Object.entries(FORMS)) {
		it(`${name}: the parser reads it as code`, () => {
			const blocks = codeBlocks(form.text)
			expect(blocks).toHaveLength(1)
			const block = blocks[0] as Extract<MdBlock, { type: 'code' }>
			expect(block.lines).toEqual(form.lines)
			expect(block.lang).toBe(form.lang)
			expect(block.indent).toBe(form.indent)
		})
	}

	it('keeps what follows a closed block out of it', () => {
		const blocks = parseMarkdown('````md\n```ts\ninner\n```\n````\n\nafter')
		expect(blocks.map((b) => b.type)).toEqual(['code', 'paragraph'])
	})

	it('reads a fence inside a quote, indented or not', () => {
		const [quote] = parseMarkdown('> ~~~ts\n>   const a = 1\n> ~~~\n')
		expect(quote?.type).toBe('quote')
		const inner = (quote as Extract<MdBlock, { type: 'quote' }>).blocks
		expect(inner).toEqual([{ type: 'code', lang: 'ts', lines: ['  const a = 1'] }])
		const [indented] = parseMarkdown('>   ```sh\n>   echo hi\n>   ```')
		expect((indented as Extract<MdBlock, { type: 'quote' }>).blocks).toEqual([
			{ type: 'code', lang: 'sh', indent: 2, lines: ['echo hi'] },
		])
	})

	it('leaves inline code and a lone pair of marks as prose', () => {
		for (const text of ['Use ```x``` here', '``double`` ticks', '~~strike~~ it', 'a ~~~ b']) {
			expect(codeBlocks(text), text).toHaveLength(0)
		}
	})
})

describe('/copy offers the blocks the parser reads', () => {
	for (const [name, form] of Object.entries(FORMS)) {
		it(`${name}`, () => {
			const targets = copyTargetsForResponse(form.text).filter((t) => t.kind === 'code')
			expect(targets).toHaveLength(1)
			expect(targets[0]?.text.replace(/\n$/u, '').split('\n')).toEqual(form.lines)
			expect(targets[0]?.label).toBe(form.lang ? `${form.lang} code` : 'Code block')
		})
	}
})

const WIDTH = 60
const reply = (content: string): TranscriptMessage => ({ id: 'r', role: 'assistant', content })

function normal(text: string, width = WIDTH): string[] {
	return renderToString(
		<ContentWidth.Provider value={width}>
			<Box width={width}>
				<Markdown text={text} />
			</Box>
		</ContentWidth.Provider>,
		{ columns: width },
	)
		.split('\n')
		.map((l) => l.trimEnd())
}

function windowed(rows: readonly FsRow[], width = WIDTH): string[] {
	return renderToString(
		<Box flexDirection="column" width={width}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
				<Box key={i} width={width} height={1}>
					<Text wrap="truncate-end">
						{row.text.length > 0
							? paintRow(row, []).map((span, j) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
									<Text key={j} color={span.color}>
										{span.text}
									</Text>
								))
							: null}
					</Text>
				</Box>
			))}
		</Box>,
		{ columns: width },
	)
		.split('\n')
		.map((l) => l.trimEnd())
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes to read the text
const plain = (rows: string[]): string[] => rows.map((r) => r.replace(/\u001b\[[0-9;]*m/gu, ''))

const LIST =
	'1. Install it:\n   ```bash\n   npm install\n   ```\n2. Run it:\n\n   ```bash\n   npm start\n   ```\n3. Done.'

describe('a block inside a list item', () => {
	it('sits at the indentation of its fence, tight under its item, without fence lines', () => {
		expect(plain(normal(LIST))).toEqual([
			'1. Install it:',
			'   npm install',
			'',
			'2. Run it:',
			'   npm start',
			'',
			'3. Done.',
		])
	})

	it('is the same rows in the fullscreen window, colour included', () => {
		const rows = fullscreenMessageRows(reply(LIST), false, WIDTH).rows
		expect(windowed(rows)).toEqual(normal(LIST))
		expect(plain(windowed(rows))).toEqual(plain(normal(LIST)))
	})

	it('draws every form the same in both screens', () => {
		for (const [name, form] of Object.entries(FORMS)) {
			const rows = fullscreenMessageRows(reply(form.text), false, WIDTH).rows
			expect(windowed(rows), name).toEqual(normal(form.text))
		}
	})

	it('draws nothing beside the code', () => {
		// (`four` holds a fence as its content, which is code and is drawn.)
		for (const [name, form] of Object.entries(FORMS).filter(([n]) => n !== 'four')) {
			const text = plain(normal(form.text)).join('\n')
			expect(text, name).not.toMatch(/[│┃▎▏|`~]{3}/u)
			expect(text, name).not.toContain(form.lang ? `${form.lang}\n` : '\u0000')
		}
	})

	it('cuts a long indented code line to the room that is left', () => {
		const long = `- item\n  \`\`\`\n  ${'x'.repeat(80)}\n  \`\`\``
		const rows = plain(normal(long, 40)).filter((r) => r.length > 0)
		expect(rows.every((r) => r.length <= 40)).toBe(true)
		const fs = plain(windowed(fullscreenMessageRows(reply(long), false, 40).rows, 40)).filter(
			(r) => r.length > 0,
		)
		expect(fs).toEqual(rows)
	})
})

describe('the fence a printed part continues', () => {
	it('is kept with its character, length and indentation', async () => {
		const { freezeMore, tailStateOf } = await import('./stream-flow.js')
		const lines = Array.from({ length: 40 }, (_, i) => `   const v${i} = ${i}`)
		const content = `1. Do:\n   ~~~~ts title=x\n${lines.join('\n')}\n   ~~~~`
		let printed: NonNullable<ReturnType<typeof freezeMore>> = []
		for (let p = 1; p <= content.length; p++) {
			printed =
				freezeMore(content.slice(0, p), printed, {
					freeze: true,
					width: 60,
					rows: 24,
					hyperlinks: false,
				}) ?? printed
		}
		const codeChunks = printed.filter((c) => c.last === 'code')
		expect(codeChunks.length).toBeGreaterThan(0)
		expect(codeChunks[0]?.fence).toBe('   ~~~~ts')
		expect(tailStateOf(codeChunks).fence ?? '   ~~~~ts').toBe('   ~~~~ts')
	})
})
