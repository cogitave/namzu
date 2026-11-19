import type { Manifest, ManifestLicenseVerifier } from '../types.js'

/** Whether the extension needs a valid licence to run at all (kind none never does). */
export const licenceRequired = (m: Manifest): boolean =>
	m.licensing.kind !== 'none' && m.licensing.required

/** The key file a package carries for its licence kind, or undefined for kind none. */
export function licenceVerifier(m: Manifest): ManifestLicenseVerifier | undefined {
	const l = m.licensing
	if (l.kind === 'key') return l.verifier
	if (l.kind === 'service') return l.service.verifier
	return undefined
}
