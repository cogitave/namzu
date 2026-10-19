import { describe, expect, it } from 'vitest'
import { modelReadsImages } from '../capabilities.js'
import { ProviderRequestError } from '../errors.js'
import { isImageInputRefusal, isImageInputRefusalMessage } from '../image-input-refusal.js'

describe('isImageInputRefusalMessage', () => {
	it.each([
		// Zen, verbatim.
		'Upstream request failed: [invalid_value] Beam supports text input only. This conversation contains an image. Remove the image from the conversation and try again.',
		'This model only supports text input',
		'Only text input is supported for this model',
		'This model is text-only',
		'gpt-x is a text-only model',
		'registry.ollama.ai/library/llama3 does not support images',
		'Model does not support images. Please use a model that does.',
		"The model doesn't support vision",
		'model does not support vision',
		'This model does not support image input',
		'Qwen2ForCausalLM does not support multimodal inputs',
		'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
		'Image input is not supported by this model',
		'images are not supported',
		'meta-llama/Llama-3-8B is not a multimodal model',
		'Invalid content type. image_url is only supported by certain models.',
		'Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text` at line 1 column 120',
	])('recognises %s', (text) => {
		expect(isImageInputRefusalMessage(text)).toBe(true)
	})

	it.each([
		// About one image, or about text somewhere else in the request: the model
		// reads images, and treating these as text-only would drop every one.
		"Invalid 'messages[3].content[1].image_url': URL scheme not supported",
		'image_url is not supported for http urls; use data URI',
		'Image format is not supported: image/webp',
		'This model does not support image/webp media type',
		'The model does not support image generation',
		'tools: this model supports text and function calling only when stream=false',
		'response_format json_schema not supported; this model supports text output',
		'This endpoint accepts text only in system messages',
		'Request contains an image larger than 5MB; reduce the text or remove it',
		'Your input contains an image that exceeds the maximum dimensions. Remove it.',
		'system prompt is text-only; tool_result must be text',
		'not supported images of size > 8000px',
		'Cannot process visual content larger than limit',
		'image input is not supported on streaming with this tier',
		'tool messages accept text only',
		'Images are not supported in tool messages',
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
