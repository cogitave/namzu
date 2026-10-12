import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
	ClearRestartMarker,
	ReadRestartMarker,
	WriteRestartMarker,
	WslcRestartMarker,
	WslcSetupStepKind,
} from './contract.js'

const STEP_KINDS: readonly WslcSetupStepKind[] = [
	'download-wsl',
	'enable-windows-features',
	'install-wsl',
	'restart',
	'load-image',
]

export function markerPath(directory: string): string {
	return join(directory, 'restart.json')
}

function parseMarker(text: string): WslcRestartMarker | undefined {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return undefined
	}
	if (typeof value !== 'object' || value === null) return undefined
	const { recordedAt, planId, remaining } = value as Record<string, unknown>
	if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) return undefined
	if (typeof planId !== 'string' || !Array.isArray(remaining)) return undefined
	if (!remaining.every((step) => STEP_KINDS.includes(step as WslcSetupStepKind))) return undefined
	return { recordedAt, planId, remaining: remaining as WslcSetupStepKind[] }
}

/** The recorded restart, or undefined when absent or not one this code wrote. */
export const readRestartMarker: ReadRestartMarker = async (host) => {
	try {
		return parseMarker(await readFile(markerPath(host.stateDirectory), 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

/** Temp file plus rename, so a reader never sees half a marker. */
export const writeRestartMarker: WriteRestartMarker = async (host, marker) => {
	await mkdir(host.stateDirectory, { recursive: true })
	const target = markerPath(host.stateDirectory)
	const temp = `${target}.${process.pid}.tmp`
	await writeFile(temp, `${JSON.stringify(marker)}\n`, 'utf8')
	try {
		await rename(temp, target)
	} catch (error) {
		await rm(temp, { force: true })
		throw error
	}
}

export const clearRestartMarker: ClearRestartMarker = async (host) => {
	await rm(markerPath(host.stateDirectory), { force: true })
}
