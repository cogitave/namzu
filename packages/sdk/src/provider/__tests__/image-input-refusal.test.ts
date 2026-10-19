import { describe, expect, it } from 'vitest'
import { modelReadsImages } from '../capabilities.js'
import { ProviderRequestError } from '../errors.js'
import { isImageInputRefusal, isImageInputRefusalMessage } from '../image-input-refusal.js'

describe('isImageInputRefusalMessage', () => {
	it.each([
		'Upstream request failed: [invalid_value] Beam supports text input only. This conversation contains an image. Remove the image from the conversation and try again.',
		'This model is text-only',
		'registry.ollama.ai/library/llama3 does not support images',
		"The model doesn't support vision",
		'Image input is not supported by this model',
		'images are not supported',
		'Invalid content type. image_url is only supported by certain models.',
		'unknown variant `image_url`, expected `text`',
	])('recognises %s', (text) => {
		expect(isImageInputRefusalMessage(text)).toBe(true)
	})

	it.each([
		'The image could not be decoded',
		'messages.0.content: Input should be a valid string',
		'invalid_image',
		'',
		undefined,
	])('leaves %s alone', (text) => {
		expect(isImageInputRefusalMessage(text)).toBe(false)
	})
})

describe('isImageInputRefusal', () => {
	const error = (kind: 'bad_request' | 'server', detail: string) =>
		new ProviderRequestError({
			kind,
			providerId: 'x',
			status: kind === 'server' ? 500 : 400,
			detail,
		})

	it('needs a bad_request that says so', () => {
		expect(isImageInputRefusal(error('bad_request', 'Beam supports text input only'))).toBe(true)
		expect(isImageInputRefusal(error('server', 'Beam supports text input only'))).toBe(false)
		expect(isImageInputRefusal(new Error('Beam supports text input only'))).toBe(false)
	})
})

describe('modelReadsImages', () => {
	it('lets the driver decline for the whole driver or for one model', () => {
		expect(modelReadsImages({}, 'm')).toBe(true)
		expect(modelReadsImages({ capabilities: { supportsVision: false } as never }, 'm')).toBe(false)
		const provider = { supportsImageInputFor: (m: string) => m !== 'beam' }
		expect(modelReadsImages(provider, 'beam')).toBe(false)
		expect(modelReadsImages(provider, 'seer')).toBe(true)
		expect(modelReadsImages(provider, undefined)).toBe(true)
	})
})
