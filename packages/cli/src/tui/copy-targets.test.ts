import { describe, expect, it } from 'vitest'

import { copyTargetsForResponse } from './copy-targets.js'

describe('copyTargetsForResponse', () => {
	it('preserves fenced code language, CRLF, trailing whitespace and source order', () => {
		const source =
			"Intro\r\n\r\n```python title=example\r\nprint('hi')  \r\n```\r\n\r\n~~~\r\nplain()\t\r\n~~~"

		expect(copyTargetsForResponse(source)).toEqual([
			{ kind: 'whole', label: 'Whole response', text: source },
			{ kind: 'code', label: 'python code', text: "print('hi')  \r\n" },
			{ kind: 'code', label: 'Code block', text: 'plain()\t\r\n' },
		])
	})

	it('offers a prose quote before its nested code and preserves nested quote Markdown', () => {
		const source =
			'> outer **bold**  \n> > inner *quote*\n> ```sh\n> nested()\n> ```\n\n```ts\nafter()\n```\n'

		expect(copyTargetsForResponse(source)).toEqual([
			{ kind: 'whole', label: 'Whole response', text: source },
			{
				kind: 'quote',
				label: 'Blockquote',
				text: 'outer **bold**  \n> inner *quote*\n```sh\nnested()\n```\n',
			},
			{ kind: 'code', label: 'sh code', text: 'nested()\n' },
			{ kind: 'code', label: 'ts code', text: 'after()\n' },
		])
	})

	it('does not duplicate a code-only quote as an empty blockquote', () => {
		const source = '> ```sh\n> echo safe\n> ```\n\n> actual prose\n'

		expect(copyTargetsForResponse(source)).toEqual([
			{ kind: 'whole', label: 'Whole response', text: source },
			{ kind: 'code', label: 'sh code', text: 'echo safe\n' },
			{ kind: 'quote', label: 'Blockquote', text: 'actual prose\n' },
		])
	})

	it('removes only the opening fence indent and keeps an unfinished body', () => {
		const source = '  ```sh\n  echo one  \n echo two\n'

		expect(copyTargetsForResponse(source)).toEqual([
			{ kind: 'whole', label: 'Whole response', text: source },
			{ kind: 'code', label: 'sh code', text: 'echo one  \necho two\n' },
		])
	})

	it('does not mutate the source while extracting targets', () => {
		const source = '> exact\n\n```js\nrun()\n```\n'
		const before = source.slice()

		copyTargetsForResponse(source)

		expect(source).toBe(before)
	})
})
