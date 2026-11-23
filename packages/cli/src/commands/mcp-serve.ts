/**
 * `namzu mcp serve`: the built-in tools as a tool server on this process's stdin and stdout.
 * What it serves and how each call is judged is in `integrations/mcp/serve.ts`; this file reads
 * the launch flags and the configuration the same way a launch does.
 */

import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { getBuiltinTools } from '@namzu/sdk'

import { loadConfig } from '../config/load.js'
import { EXIT_BAD_CONFIG, EXIT_OK, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { NamzuToolProvider, serveMcpTools } from '../integrations/mcp/serve.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { launchRefusal } from '../permissions/launch.js'
import {
	type PermissionMode,
	permissionModeFromName,
	unknownPermissionModeMessage,
} from '../permissions/mode.js'
import { compilePermissionLayers, permissionLayersOf } from '../permissions/rules.js'
import { toolFlagLayers } from '../permissions/tool-flags.js'
import { refusedByLayers } from '../schedule/policy.js'
import { CLI_VERSION } from '../version.js'
import type { CommandContext } from './types.js'

export const MCP_SERVE_USAGE =
	'Usage: namzu mcp serve [--permission-mode <mode>] [--allowed-tools <list>] [--disallowed-tools <list>] [--add-dir <path>] [--trust]'

interface ServeFlags {
	mode: string | null
	allowedTools: string[]
	disallowedTools: string[]
	addDirs: string[]
	trust: boolean
}

function parseServeFlags(args: readonly string[]): ServeFlags | { readonly error: string } {
	const flags: ServeFlags = {
		mode: null,
		allowedTools: [],
		disallowedTools: [],
		addDirs: [],
		trust: false,
	}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string
		if (arg === '--trust') {
			flags.trust = true
			continue
		}
		if (
			arg === '--permission-mode' ||
			arg === '--allowed-tools' ||
			arg === '--disallowed-tools' ||
			arg === '--add-dir'
		) {
			const value = args[++index]
			if (value === undefined || value === '') return { error: `${arg} needs a value.` }
			if (arg === '--permission-mode') flags.mode = value
			else if (arg === '--allowed-tools') flags.allowedTools.push(value)
			else if (arg === '--disallowed-tools') flags.disallowedTools.push(value)
			else flags.addDirs.push(value)
			continue
		}
		return { error: `Unknown mcp serve option: ${arg}. ${MCP_SERVE_USAGE}` }
	}
	return flags
}

export async function runMcpServe(opts: {
	readonly args: readonly string[]
	readonly ctx: CommandContext
	readonly input: Readable
	readonly output: Writable
	readonly cwd: string
}): Promise<number> {
	const { ctx } = opts
	const flags = parseServeFlags(opts.args)
	if ('error' in flags) {
		ctx.formatter.error({ message: flags.error })
		return EXIT_USAGE
	}
	let mode: PermissionMode | undefined
	if (flags.mode !== null) {
		mode = permissionModeFromName(flags.mode)
		if (mode === undefined) {
			ctx.formatter.error({ message: unknownPermissionModeMessage(flags.mode) })
			return EXIT_USAGE
		}
	}
	const tools = toolFlagLayers(flags)
	const problem = tools.problems[0]
	if (problem) {
		ctx.formatter.error({ message: `${problem.flag}: ${problem.message}` })
		return EXIT_USAGE
	}
	// The folder is trusted before its settings are read, as for every headless launch.
	const trust = decideHeadlessTrust({ cwd: opts.cwd, trustFlag: flags.trust })
	if (!trust.allowed) {
		ctx.formatter.error({ message: trust.message })
		return EXIT_UNTRUSTED
	}
	let config: ReturnType<typeof loadConfig>
	try {
		config = loadConfig({ profile: ctx.selectedProfile, cwd: trust.cwd })
	} catch (error) {
		ctx.formatter.error({
			message: error instanceof Error ? error.message : 'The configuration could not be loaded.',
		})
		return EXIT_BAD_CONFIG
	}
	if (mode !== undefined) {
		const refusal = launchRefusal(mode, { settings: config.permissionSettings })
		if (refusal) {
			ctx.formatter.error({ message: refusal })
			return EXIT_USAGE
		}
	}
	const tables = [...permissionLayersOf(config), ...tools.layers]
	const compiled = compilePermissionLayers(tables, config.permissionChecks)
	for (const d of compiled.diagnostics) {
		const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
		ctx.formatter.error({ message: `${where}: ${d.message}` })
	}
	const provider = new NamzuToolProvider({
		cwd: trust.cwd,
		additionalDirectories: [...(config.additionalDirectories ?? []), ...flags.addDirs].map((dir) =>
			resolve(trust.cwd, dir),
		),
		rules: compiled.rules,
		withheld: refusedByLayers(tables),
		...(mode !== undefined ? { mode } : {}),
		tools: getBuiltinTools(),
	})
	ctx.formatter.info(`namzu mcp serve · ${provider.listTools().length} tools · ${trust.cwd}`)
	await serveMcpTools(provider, { input: opts.input, output: opts.output }, CLI_VERSION)
	return EXIT_OK
}
