/**
 * `namzu tools` — real implementation, replacing the M0 stub.
 *
 * Subcommands:
 *   - `ls`           List tools clawtool exposes (auto-spawns daemon).
 *   - `run <name>`   Invoke a tool by name with JSON arguments.
 *   - `sync-types`   Generate local TS stubs via `clawtool tools export-typescript`.
 *
 * The command runs in passThrough mode — its own Commander instance parses
 * the subcommand args. This keeps the top-level shell free of vendor-tool
 * coupling and lets us expand the surface later (e.g. `tools search`)
 * without touching the outer registry.
 */

import { execFileSync } from 'node:child_process'

import { Command, CommanderError } from 'commander'

import {
	type ClawtoolPlugin,
	type CreateClawtoolPluginOptions,
	createClawtoolPlugin,
	findBinary,
} from '../integrations/clawtool/index.js'
import { isExcludedClawtoolTool } from '../integrations/clawtool/tooling.js'
import type { CommandContext, CommandDef } from './types.js'

let cachedPlugin: ClawtoolPlugin | null = null

async function getPlugin(ctx: CommandContext): Promise<ClawtoolPlugin> {
	if (cachedPlugin) return cachedPlugin
	const cfg = ctx.config.clawtool ?? {}
	const opts: CreateClawtoolPluginOptions = {
		binary: cfg.binary,
		endpoint: cfg.endpoint,
		token: cfg.token,
		autoStart: cfg.autoStart,
		clientInfo: { name: 'namzu-cli', version: '0.0.0' },
	}
	cachedPlugin = await createClawtoolPlugin(opts)
	return cachedPlugin
}

async function runLs(ctx: CommandContext): Promise<number> {
	const plugin = await getPlugin(ctx)
	// Mirror what the agent actually gets: drop the tools namzu excludes from
	// the bridged catalog (e.g. clawtool's `.claude/agents` Agent* family), so
	// `tools ls` doesn't advertise tools the model can't call.
	const tools = plugin.tools.filter((t) => !isExcludedClawtoolTool(t.name))
	ctx.formatter.print({
		source: 'clawtool',
		endpoint: plugin.endpoint.baseUrl,
		count: tools.length,
		tools: tools.map((t) => ({
			name: t.name,
			source: t.source,
			description: t.description,
		})),
	})
	return 0
}

async function runRun(ctx: CommandContext, name: string, inputJson: string): Promise<number> {
	let args: Record<string, unknown>
	try {
		args = JSON.parse(inputJson) as Record<string, unknown>
		if (typeof args !== 'object' || args === null || Array.isArray(args)) {
			throw new Error('--input must be a JSON object')
		}
	} catch (err) {
		ctx.formatter.error({
			message: `invalid --input JSON: ${err instanceof Error ? err.message : String(err)}`,
		})
		return 64
	}
	const plugin = await getPlugin(ctx)
	const tool = plugin.tools.find((t) => t.name === name)
	if (!tool) {
		ctx.formatter.error({
			message: `no tool named "${name}"; run \`namzu tools ls\` for the catalog`,
		})
		return 64
	}
	const result = await tool.call(args)
	ctx.formatter.print({
		tool: name,
		isError: Boolean(result.isError),
		content: result.content,
	})
	return result.isError ? 1 : 0
}

async function runSyncTypes(ctx: CommandContext, output: string): Promise<number> {
	const cfg = ctx.config.clawtool ?? {}
	let binary: string
	try {
		binary = findBinary({ override: cfg.binary })
	} catch (err) {
		ctx.formatter.error({
			message: err instanceof Error ? err.message : String(err),
		})
		return 70
	}
	try {
		execFileSync(binary, ['tools', 'export-typescript', '--output', output], {
			stdio: 'inherit',
		})
	} catch (err) {
		ctx.formatter.error({
			message: `clawtool export-typescript failed: ${err instanceof Error ? err.message : String(err)}`,
		})
		return 70
	}
	ctx.formatter.info(`clawtool tool types exported to ${output}`)
	return 0
}

export const toolsCommand: CommandDef = {
	name: 'tools',
	description: 'Inspect and run tools via the clawtool tool layer',
	passThrough: true,
	async handler({ ctx, rawArgs }) {
		let exitCode = 0
		const program = new Command('tools')
			.description('Inspect and run tools via the clawtool tool layer')
			.exitOverride()
			.helpOption('-h, --help', 'Show this help')

		program
			.command('ls')
			.description('List all tools clawtool exposes (auto-spawns the daemon)')
			.action(async () => {
				exitCode = await runLs(ctx)
			})

		program
			.command('run <name>')
			.description('Invoke a tool by name with JSON arguments')
			.option('--input <json>', 'JSON arguments object', '{}')
			.action(async (name: string, opts: { input: string }) => {
				exitCode = await runRun(ctx, name, opts.input)
			})

		program
			.command('sync-types')
			.description('Generate TS stubs from `clawtool tools export-typescript`')
			.option('--output <dir>', 'Output directory', './.namzu/clawtool-types')
			.action(async (opts: { output: string }) => {
				exitCode = await runSyncTypes(ctx, opts.output)
			})

		if (rawArgs.length === 0) {
			program.outputHelp()
			return 0
		}

		try {
			await program.parseAsync(rawArgs as string[], { from: 'user' })
			return exitCode
		} catch (err) {
			if (err instanceof CommanderError) {
				if (
					err.code === 'commander.help' ||
					err.code === 'commander.helpDisplayed' ||
					err.code === 'commander.version'
				) {
					return 0
				}
				return 64
			}
			ctx.formatter.error({
				message: err instanceof Error ? err.message : String(err),
			})
			return 70
		}
	},
}
