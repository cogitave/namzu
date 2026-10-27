/**
 * Whether this process may look for a newer Namzu, whether it may install one
 * without being asked, and which channel it follows.
 *
 * Order, strongest first: the environment, then your own config files, then the
 * default. The default installs for a person at a terminal and not in CI.
 */

import type { UpdateChannel, UpdatesConfig } from '../../config/schema.js'

export interface UpdatePolicy {
	/** Look for a newer version in the background (and show the footer line). */
	readonly check: boolean
	/** Install it without being asked. Implies `check`. */
	readonly install: boolean
	readonly channel: UpdateChannel
	/** What decided `install`, for `namzu upgrade --check` and the docs. */
	readonly decidedBy: 'environment' | 'config' | 'ci' | 'default'
}

export interface UpdatePolicyInput {
	readonly config?: UpdatesConfig | undefined
	readonly env: NodeJS.ProcessEnv
	/** A person at a terminal. The updater loop only runs in the terminal UI, which is. */
	readonly interactive: boolean
}

const ON_WORDS = new Set(['1', 'true', 'yes', 'on'])
const OFF_WORDS = new Set(['0', 'false', 'no', 'off'])

function readSwitch(value: string | undefined): boolean | undefined {
	const word = value?.trim().toLowerCase()
	if (!word) return undefined
	if (ON_WORDS.has(word)) return true
	if (OFF_WORDS.has(word)) return false
	return undefined
}

/** True when the process looks like it runs inside a CI job. */
export function runsInCi(env: NodeJS.ProcessEnv): boolean {
	for (const name of [
		'CI',
		'GITHUB_ACTIONS',
		'GITLAB_CI',
		'BUILDKITE',
		'JENKINS_URL',
		'TF_BUILD',
	]) {
		const value = env[name]?.trim().toLowerCase()
		if (value && !OFF_WORDS.has(value)) return true
	}
	return false
}

export function parseUpdateChannel(value: string | undefined): UpdateChannel | undefined {
	const word = value?.trim().toLowerCase()
	return word === 'latest' || word === 'stable' ? word : undefined
}

export function resolveUpdatePolicy(input: UpdatePolicyInput): UpdatePolicy {
	const { config, env } = input
	const channel = parseUpdateChannel(env.NAMZU_UPDATE_CHANNEL) ?? config?.channel ?? 'latest'
	const check = readSwitch(env.NAMZU_UPDATE_CHECK) ?? config?.check ?? true
	if (!check) return { check: false, install: false, channel, decidedBy: 'environment' }

	const fromEnv = readSwitch(env.NAMZU_AUTO_UPDATE)
	if (fromEnv !== undefined) {
		return { check: true, install: fromEnv, channel, decidedBy: 'environment' }
	}
	if (config?.auto !== undefined) {
		return { check: true, install: config.auto, channel, decidedBy: 'config' }
	}
	if (runsInCi(env)) return { check: true, install: false, channel, decidedBy: 'ci' }
	return { check: true, install: input.interactive, channel, decidedBy: 'default' }
}
