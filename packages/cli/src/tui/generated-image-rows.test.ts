import { describe, expect, it } from 'vitest'
import { generatedImageRows } from './generated-image-rows.js'
import { type ToolEndEvent, toolEndRows } from './tool-end-rows.js'

const OUTPUT = [
	'Image generated and already shown to the person.',
	'Prompt: a red fox on a hill',
	'Saved to: /home/me/.namzu/generated_images/s1/call_1.png',
	'The generated image is already displayed to the person.',
].join('\n')

function event(output: string, isError = false): ToolEndEvent {
	return {
		kind: 'tool-end',
		toolUseId: 'call_1',
		toolName: 'generate_image',
		isError,
		summary: '',
		output,
	} as ToolEndEvent
}

describe('generate_image rows', () => {
	it('draws a heading, the prompt and where it was saved', () => {
		const rows = generatedImageRows(OUTPUT, false)
		expect(rows?.map((row) => row.content)).toEqual([
			'Generated image',
			'  a red fox on a hill',
			'  └ Saved to /home/me/.namzu/generated_images/s1/call_1.png',
		])
	})

	it('draws a failure with its reason', () => {
		const rows = generatedImageRows(
			'image generation failed: The image quota of this plan is used up. It resets soon.',
			true,
		)
		expect(rows?.[0]?.content).toBe('Image generation failed')
		expect(rows?.[1]?.content).toBe('  └ The image quota of this plan is used up. It resets soon.')
	})

	it('is what the live path and a resumed conversation both draw from the saved result text', () => {
		const live = toolEndRows(event(OUTPUT), undefined, { hasPlan: false })
		expect(live.kind).toBe('rows')
		expect(live.kind === 'rows' && live.rows.map((row) => row.content)).toEqual(
			generatedImageRows(OUTPUT, false)?.map((row) => row.content),
		)
		// Nothing in the rows can hold image bytes: the text names a path only.
		expect(JSON.stringify(live)).not.toMatch(/base64/)
	})

	it('draws nothing it cannot read', () => {
		expect(generatedImageRows('something else', false)).toBeUndefined()
		expect(generatedImageRows(undefined, false)).toBeUndefined()
	})
})
