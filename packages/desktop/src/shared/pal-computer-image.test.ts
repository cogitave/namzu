import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { PAL_COMPUTER_IMAGE_BYTES, palComputerImageSize } from './pal-computer-image.js'

it('says "about 1.2 GB" for the bundled image', () => {
	expect(palComputerImageSize()).toBe('about 1.2 GB')
})

it('uses the byte count the Local Pal computers page gives for the image', () => {
	const page = readFileSync(
		fileURLToPath(new URL('../../../../docs/sdk/local-pal-computer.md', import.meta.url)),
		'utf8',
	)
	const figure = /Image on disk \| [\d.]+ GB \(([\d,]+) bytes/.exec(page)
	expect(figure, 'the page no longer states the image size in bytes').not.toBeNull()
	expect(Number((figure as RegExpExecArray)[1]?.replaceAll(',', ''))).toBe(PAL_COMPUTER_IMAGE_BYTES)
})
