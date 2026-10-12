import type { DownloadWslPackage, PinnedWslPackage } from './contract.js'
import { notImplemented } from './not-implemented.js'

/** The WSL release setup installs. Filled in with the verified digest and size. */
export const PINNED_WSL_PACKAGE: PinnedWslPackage = {
	version: '3.0.1.0',
	architecture: 'x64',
	url: 'https://github.com/microsoft/WSL/releases/download/3.0.1/wsl.3.0.1.0.x64.msi',
	sha256: '',
	sizeBytes: 0,
}

export const downloadWslPackage: DownloadWslPackage = async () => {
	throw notImplemented('downloadWslPackage')
}
