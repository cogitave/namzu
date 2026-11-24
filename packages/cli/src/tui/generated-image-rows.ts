import { homePath } from './person-terms.js'
import { tokenColor } from './theme.js'
import type { ToolRow } from './tool-end-rows.js'

/** The tool whose result these rows draw. */
export const GENERATE_IMAGE_TOOL = 'generate_image'

const FAILED_PREFIX = 'image generation failed:'

function field(lines: readonly string[], name: string): string | undefined {
	const prefix = `${name}: `
	const line = lines.find((candidate) => candidate.startsWith(prefix))
	const value = line?.slice(prefix.length).trim()
	return value ? value : undefined
}

/**
 * The rows a finished `generate_image` call leaves: a "Generated image"
 * heading, the prompt, and where the file was saved; or "Image generation
 * failed" with the reason. Read from the result text alone, so a resumed
 * conversation draws the same rows from the saved result without any image
 * bytes. `undefined` when the text is neither shape.
 */
export function generatedImageRows(
	output: string | undefined,
	isError: boolean,
	home?: string,
): readonly ToolRow[] | undefined {
	if (output === undefined) return undefined
	const lines = output.split('\n')
	if (isError || output.toLowerCase().startsWith(FAILED_PREFIX)) {
		const reason = output
			.slice(output.toLowerCase().startsWith(FAILED_PREFIX) ? FAILED_PREFIX.length : 0)
			.trim()
		return [
			{
				role: 'tool',
				content: 'Image generation failed',
				glyph: '✗',
				glyphColor: tokenColor('status.error'),
			},
			...(reason
				? [
						{
							role: 'tool' as const,
							content: `  └ ${reason.split('\n')[0]}`,
							glyph: ' ',
							glyphColor: tokenColor('text.muted'),
						},
					]
				: []),
		]
	}
	const saved = field(lines, 'Saved to')
	if (saved === undefined) return undefined
	const prompt = field(lines, 'Prompt')
	return [
		{
			role: 'tool',
			content: 'Generated image',
			glyph: '●',
			glyphColor: tokenColor('status.ok'),
		},
		...(prompt
			? [
					{
						role: 'tool' as const,
						content: `  ${prompt}`,
						glyph: ' ',
						glyphColor: tokenColor('text.muted'),
					},
				]
			: []),
		{
			role: 'tool',
			// The home folder as `~`, like every other path row, so the line is short enough to stay whole.
			content: `  └ Saved to ${homePath(saved, home)}`,
			glyph: ' ',
			glyphColor: tokenColor('text.muted'),
		},
	]
}
