/**
 * The service's name: `namzu-scheduler` for the default home, otherwise
 * `namzu-scheduler-<8 hex of the home's hash>`, so two homes never share a
 * service. A service installed by name (`schedule service install <name>`) is
 * named by that word instead, and its home is `<default home>/services/<name>`.
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

/** `<name>-schedule-workspaces` is where a home's no-project jobs keep their scratch folders. */
const SCRATCH_SUFFIX = '-schedule-workspaces'

export function checkServiceName(name: string): string {
	if (!SERVICE_NAME.test(name)) {
		throw new Error(
			`"${name}" is not a service name: letters, digits, dot, dash and underscore only`,
		)
	}
	if (name.endsWith(SCRATCH_SUFFIX)) {
		throw new Error(
			`"${name}" is not a service name: ${SCRATCH_SUFFIX} is kept for a service's scratch folders`,
		)
	}
	return name
}
