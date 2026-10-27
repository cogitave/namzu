/**
 * The health checks as one running session sees them.
 *
 * `namzu doctor` and `/doctor` build the same registry, so a check added to
 * one is in the other. Config-dependent checks are constructed here, from the
 * resolved config of the invocation they report on.
 */

import type { DoctorReport } from '@namzu/sdk'

import type { NamzuCliConfig } from '../config/schema.js'
import { CLI_VERSION } from '../version.js'
import { builtInDoctorChecks } from './checks/index.js'
import { sessionExportCheck } from './checks/session-export.js'
import {
	type DoctorRegistry,
	type RunDoctorOptions,
	createDoctorRegistry,
	runDoctor,
} from './registry.js'

/** The registry with every built-in check and the ones that read this invocation's config. */
export function buildDoctorRegistry(config: NamzuCliConfig = {}): DoctorRegistry {
	const registry = createDoctorRegistry()
	for (const check of builtInDoctorChecks) registry.register(check)
	// What the session-export check reports is a property of THIS invocation's
	// resolved config; a check registered without one could only say "unknown".
	registry.register(sessionExportCheck(config))
	return registry
}

/** Run every check once and return the report. */
export function runLiveDoctor(
	config: NamzuCliConfig = {},
	options: Omit<RunDoctorOptions, 'registry' | 'version'> = {},
): Promise<DoctorReport> {
	return runDoctor({ ...options, registry: buildDoctorRegistry(config), version: CLI_VERSION })
}
