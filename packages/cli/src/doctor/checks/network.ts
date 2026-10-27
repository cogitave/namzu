import { constants, accessSync } from 'node:fs'

import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { describeNetwork } from '../../network/install.js'
import { readNetworkSettings } from '../../network/settings.js'

type Env = Readonly<Record<string, string | undefined>>

function readable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK)
		return true
	} catch {
		return false
	}
}

/**
 * How requests leave this machine: through a proxy or directly, with which
 * extra certificate authorities and which client certificate.
 *
 * A row of its own because every one of these fails far from where it was set:
 * a proxy that wants a sign-in, an authority file Node silently ignores, and a
 * certificate path that moved all show up later as a provider that "could not
 * be reached".
 */
export function describeNetworkStatus(
	env: Env = process.env,
	canRead: (path: string) => boolean = readable,
): DoctorCheckResult {
	const settings = readNetworkSettings(env)
	const issues = settings.problems.map((problem) => problem.message)
	const authorities = env.NODE_EXTRA_CA_CERTS?.trim()
	if (authorities && !canRead(authorities)) {
		issues.push(
			'NODE_EXTRA_CA_CERTS points to a file that cannot be read, so extra certificate authorities are not trusted.',
		)
	}
	for (const [variable, path] of [
		['NAMZU_CLIENT_CERT', settings.clientCert],
		['NAMZU_CLIENT_KEY', settings.clientKey],
	] as const) {
		if (path && !canRead(path)) issues.push(`${variable} points to a file that cannot be read.`)
	}
	if (issues.length > 0) {
		return {
			status: 'warn',
			message: issues.join(' '),
			remediation:
				'Fix or unset the variable named above, then start Namzu again. Proxy addresses look like http://host:3128; HTTPS_PROXY, HTTP_PROXY and NO_PROXY are read as written.',
		}
	}
	const parts = [
		describeNetwork(settings) ?? 'No proxy is set; requests go out directly.',
		authorities ? 'Extra certificate authorities are trusted from NODE_EXTRA_CA_CERTS.' : null,
	]
	return { status: 'pass', message: parts.filter(Boolean).join(' ') }
}

export const networkCheck: DoctorCheck = {
	id: 'runtime.network',
	category: 'runtime',
	run: async (): Promise<DoctorCheckResult> => describeNetworkStatus(),
}
