/** The Pal computer image the application carries, found through its manifest. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The image reference used when a manifest does not name one. */
export const DEFAULT_PAL_COMPUTER_IMAGE = 'namzu-local-computer:2'

export interface PalComputerBundle {
	readonly manifestPath: string
	readonly imageRef: string
	/** The parsed manifest, as the setup module's planner reads it. */
	readonly manifest: Record<string, unknown>
}

/** Raised when a named bundle cannot be used; the message is a plain sentence. */
export class PalComputerBundleError extends Error {
	override readonly name = 'PalComputerBundleError'
}

/**
 * Read `<directory>/manifest.json`. The directory comes from `--bundle` or
 * `NAMZU_PAL_COMPUTER_BUNDLE`; an empty value means there is no bundle.
 */
export function readPalComputerBundle(
	directory: string | undefined,
): PalComputerBundle | undefined {
	if (directory === undefined || directory.trim() === '') return undefined
	const manifestPath = join(directory, 'manifest.json')
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
	} catch {
		throw new PalComputerBundleError(
			'The Pal computer folder does not contain a readable manifest.json.',
		)
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new PalComputerBundleError('The Pal computer manifest.json is not valid.')
	const manifest = parsed as Record<string, unknown>
	const ref = manifest.imageRef
	return {
		manifestPath,
		imageRef: typeof ref === 'string' && ref.trim() !== '' ? ref : DEFAULT_PAL_COMPUTER_IMAGE,
		manifest,
	}
}
