import { nativeImage } from 'electron'

/**
 * Shrinks a screenshot's base64 data to at most `maxChars` characters by scaling the picture down
 * until it fits, as the agent's page capture may be larger than one message can carry. A PNG stays a
 * PNG and anything else becomes a JPEG. Returns undefined when it cannot be made small enough.
 */
export async function shrinkImage(
	data: string,
	format: string,
	maxChars: number,
): Promise<string | undefined> {
	let image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
	if (image.isEmpty()) return undefined
	for (let round = 0; round < 8; round++) {
		const { width, height } = image.getSize()
		image = image.resize({
			width: Math.max(1, Math.round(width * 0.7)),
			height: Math.max(1, Math.round(height * 0.7)),
		})
		const bytes = format === 'png' ? image.toPNG() : image.toJPEG(80)
		const text = bytes.toString('base64')
		if (text.length <= maxChars) return text
	}
	return undefined
}
