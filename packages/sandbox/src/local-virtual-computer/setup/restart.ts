import type { ClearRestartMarker, ReadRestartMarker, WriteRestartMarker } from './contract.js'
import { notImplemented } from './not-implemented.js'

export const readRestartMarker: ReadRestartMarker = async () => {
	throw notImplemented('readRestartMarker')
}
export const writeRestartMarker: WriteRestartMarker = async () => {
	throw notImplemented('writeRestartMarker')
}
export const clearRestartMarker: ClearRestartMarker = async () => {
	throw notImplemented('clearRestartMarker')
}
