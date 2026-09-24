/**
 * `schedule/service.json`: what `schedule install` created, so `uninstall`
 * removes exactly that and verifies each piece is gone.
 */

import { rmSync } from 'node:fs'
import type { SchedulePaths } from '../paths.js'
import { readVersioned, writeJsonAtomic } from '../store/atomic.js'

export type ServicePlatform = 'systemd-user' | 'launchd' | 'windows-task' | 'wsl-windows-task'

export type ServiceArtifact =
	| { readonly type: 'file'; readonly path: string }
	| { readonly type: 'systemd-unit'; readonly name: string }
	| { readonly type: 'launchd-agent'; readonly label: string; readonly domain: string }
	| { readonly type: 'windows-task'; readonly taskPath: string }

export interface ServiceManifest {
	readonly v: 1
	readonly kind: 'schedule-service'
	readonly platform: ServicePlatform
	readonly name: string
	readonly installedAt: string
	readonly cliVersion: string
	readonly nodePath: string
	readonly binPath: string
	readonly namzuHome: string
	readonly enabledLinger?: boolean
	readonly artifacts: readonly ServiceArtifact[]
	readonly windows?: {
		readonly taskPath: string
		readonly schtasks: string
		readonly powershell?: string
		readonly distro?: string
		readonly user?: string
	}
}

export function readManifest(paths: SchedulePaths): ServiceManifest | undefined {
	return readVersioned<ServiceManifest>(paths.service, 'schedule-service', 1)
}

export function writeManifest(paths: SchedulePaths, manifest: ServiceManifest): void {
	writeJsonAtomic(paths.service, manifest)
}

export function removeManifest(paths: SchedulePaths): void {
	rmSync(paths.service, { force: true })
}
