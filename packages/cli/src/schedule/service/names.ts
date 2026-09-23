/**
 * The service's name: `namzu-scheduler` for the default home, otherwise
 * `namzu-scheduler-<8 hex of the home's hash>`, so two homes never share a
 * service. `--name` overrides it (the real-machine test uses a unique one).
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export function defaultServiceName(namzuHome: string, osHome = homedir()): string {
	if (resolve(namzuHome) === resolve(join(osHome, '.namzu'))) return 'namzu-scheduler'
	const h8 = createHash('sha256').update(resolve(namzuHome)).digest('hex').slice(0, 8)
	return `namzu-scheduler-${h8}`
}

export function checkServiceName(name: string): string {
	if (!SERVICE_NAME.test(name)) {
		throw new Error(
			`"${name}" is not a service name: letters, digits, dot, dash and underscore only`,
		)
	}
	return name
}
