/**
 * What `namzu doctor` says about updates: whether a newer version is known, and
 * when Namzu cannot install it, the reason and the full command. Reads only the
 * files the updater keeps; it never asks the registry.
 */

import { compareVersions } from '../updates.js'
import { type FailureStatus, describeFailure, manualUpdateCommand, scopeOf } from './apply.js'
import type { InstallKind } from './install-kind.js'
import { readAttempt, readCheck, readLastResult } from './state.js'

export type UpdateStatus =
	| { readonly state: 'not-applicable' }
	| { readonly state: 'current'; readonly version: string }
	| {
			readonly state: 'available'
			readonly latest: string
			/** What the person can run; null when nothing can be. */
			readonly command: string | null
	  }
	| {
			readonly state: 'cannot-install'
			readonly latest: string
			readonly folder: string
			readonly reason: string
			readonly command: string | null
			readonly log?: string
	  }
	| {
			readonly state: 'failed-version'
			readonly latest: string
			readonly reason: string
			readonly log?: string
	  }

export interface UpdateStatusInput {
	readonly currentVersion: string
	readonly install: InstallKind
	readonly home: string
	readonly platform: NodeJS.Platform
}

export function readUpdateStatus(input: UpdateStatusInput): UpdateStatus {
	const { install, home, platform, currentVersion } = input
	if (install.kind === 'development' || install.kind === 'ephemeral' || install.kind === 'desktop')
		return { state: 'not-applicable' }
	const check = readCheck(home)
	if (!check || compareVersions(check.version, currentVersion) <= 0)
		return { state: 'current', version: currentVersion }
	const latest = check.version
	if (install.kind !== 'npm-global' && install.kind !== 'pnpm-global')
		return { state: 'available', latest, command: manualUpdateCommand(install, latest, platform) }

	const scope = scopeOf(install, platform)
	const attempt = readAttempt(home, scope)
	const last = readLastResult(home, scope)
	const failedHere = attempt && attempt.version === latest ? (attempt.code as FailureStatus) : null
	const log = last?.to === latest && last.log ? last.log : undefined
	const folder = install.kind === 'pnpm-global' ? install.globalDir : install.prefix
	if (failedHere === 'no_permission' || !install.writable) {
		return {
			state: 'cannot-install',
			latest,
			folder,
			reason: 'Namzu cannot write to the folder it is installed in.',
			command: manualUpdateCommand({ ...install, writable: false }, latest, platform),
			...(log ? { log } : {}),
		}
	}
	if (
		failedHere &&
		failedHere !== 'network' &&
		failedHere !== 'in_use' &&
		failedHere !== 'disk_full' &&
		failedHere !== 'backup_failed'
	) {
		return {
			state: 'failed-version',
			latest,
			reason: `${describeFailure(failedHere)} Namzu stays on ${currentVersion} until a newer version is published.`,
			...(log ? { log } : {}),
		}
	}
	return { state: 'available', latest, command: manualUpdateCommand(install, latest, platform) }
}
