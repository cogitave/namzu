/**
 * Config cascade for @namzu/cli (M0 scaffolding).
 *
 * Resolution order (highest priority first):
 *   1. CLI flags (handled by Commander, merged in `bin.ts`)
 *   2. Environment variables prefixed `NAMZU_`
 *   3. Project config: `./namzu.config.json` (TS variant added in a later
 *      milestone when a build step is justified)
 *   4. User config: `~/.namzu/config.yaml`
 *   5. Built-in defaults from `schema.ts`
 *
 * In M0 we wire steps 2, 3, 4, 5. CLI-flag merging happens in `bin.ts`
 * where Commander knows what was explicitly set vs defaulted.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse as yamlParse } from 'yaml'

import { type FormatName, isFormatName } from '../output/index.js'
import { DEFAULT_CONFIG, type NamzuCliConfig } from './schema.js'

export interface LoadConfigOptions {
	/** Override the user's home dir (testing). */
	readonly home?: string
	/** Override the project root (testing or non-cwd execution). */
	readonly cwd?: string
	/** Replacement env source (testing). */
	readonly env?: NodeJS.ProcessEnv
}

export function loadConfig(opts: LoadConfigOptions = {}): NamzuCliConfig {
	const home = opts.home ?? homedir()
	const cwd = opts.cwd ?? process.cwd()
	const env = opts.env ?? process.env

	const userPath = join(home, '.namzu', 'config.yaml')
	const projectPath = resolve(cwd, 'namzu.config.json')

	const userCfg = readYamlIfExists(userPath)
	const projectCfg = readJsonIfExists(projectPath)
	const envCfg = readEnv(env)

	return mergeConfigs(DEFAULT_CONFIG, userCfg, projectCfg, envCfg)
}

function readYamlIfExists(path: string): MutableConfig {
	const raw = safeRead(path)
	if (raw === null) return {}
	try {
		return sanitize(yamlParse(raw))
	} catch {
		return {}
	}
}

function readJsonIfExists(path: string): MutableConfig {
	const raw = safeRead(path)
	if (raw === null) return {}
	try {
		return sanitize(JSON.parse(raw))
	} catch {
		return {}
	}
}

interface MutableConfig {
	format?: FormatName
	quiet?: boolean
}

function readEnv(env: NodeJS.ProcessEnv): MutableConfig {
	const out: MutableConfig = {}
	const format = env.NAMZU_FORMAT
	if (format && isFormatName(format)) {
		out.format = format
	}
	const quiet = env.NAMZU_QUIET
	if (quiet === '1' || quiet === 'true') out.quiet = true
	if (quiet === '0' || quiet === 'false') out.quiet = false
	return out
}

function sanitize(value: unknown): MutableConfig {
	if (typeof value !== 'object' || value === null) return {}
	const v = value as Record<string, unknown>
	const out: MutableConfig = {}
	if (typeof v.format === 'string' && isFormatName(v.format)) out.format = v.format
	if (typeof v.quiet === 'boolean') out.quiet = v.quiet
	return out
}

function mergeConfigs(...sources: readonly MutableConfig[]): NamzuCliConfig {
	const out: MutableConfig = {}
	for (const src of sources) Object.assign(out, src)
	return out as NamzuCliConfig
}

function safeRead(path: string): string | null {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return null
	}
}
