import { describe, expect, it } from 'vitest'
import { type FaceLoader, MONO_FACE, SANS_FACE, facesReady } from './font-faces.js'

function loader() {
	const calls: string[] = []
	let finish!: () => void
	const ready = new Promise<void>((resolve) => {
		finish = resolve
	})
	const fonts: FaceLoader = {
		load: (font) => {
			calls.push(font)
			return Promise.resolve([])
		},
		ready,
	}
	return { fonts, calls, finish }
}

describe('facesReady', () => {
	it('asks for each face and then waits for the document’s own ready', async () => {
		const { fonts, calls, finish } = loader()
		let done = false
		const promise = facesReady(fonts, [SANS_FACE, MONO_FACE]).then(() => {
			done = true
		})
		await Promise.resolve()
		await Promise.resolve()
		expect(calls).toEqual([SANS_FACE, MONO_FACE])
		expect(done).toBe(false)
		finish()
		await promise
		expect(done).toBe(true)
	})

	it('settles without a font set, and when a face cannot load', async () => {
		await expect(facesReady(undefined)).resolves.toBeUndefined()
		const broken: FaceLoader = {
			load: () => Promise.reject(new Error('missing')),
			ready: Promise.resolve(),
		}
		await expect(facesReady(broken, [MONO_FACE])).resolves.toBeUndefined()
	})
})
