interface PresentedCanvas {
	readonly width: number
	readonly height: number
	getContext(kind: '2d'): Pick<CanvasRenderingContext2D, 'getImageData'> | null
}

/**
 * A correctly sized noVNC canvas starts transparent. Its visible framebuffer
 * becomes opaque when Display.flip presents guest pixels, including pure black.
 * Read the public canvas, not noVNC's hidden backbuffer or private internals.
 */
export function computerFramePresented(
	canvas: PresentedCanvas,
	expected: { readonly width: number; readonly height: number },
): boolean {
	const { width, height } = expected
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		canvas.width !== width ||
		canvas.height !== height
	)
		return false
	try {
		const context = canvas.getContext('2d')
		if (!context) return false
		const points = [
			[Math.floor(width / 2), Math.floor(height / 2)],
			[0, 0],
			[width - 1, 0],
			[0, height - 1],
			[width - 1, height - 1],
		] as const
		return points.every(([x, y]) => context.getImageData(x, y, 1, 1).data[3] === 255)
	} catch {
		return false
	}
}
