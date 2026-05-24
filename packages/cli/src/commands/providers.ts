/**
 * `namzu providers` — real implementation, replacing the M0 stub.
 *
 * Subcommands:
 *   - `ls`             List configured profiles (mask secrets by default).
 *   - `add <name>`     Persist a new profile.
 *   - `remove <name>`  Drop a profile from the store.
 *   - `default <name>` Flip the `default` flag onto one profile.
 *   - `path`           Print the store path (useful for env automation).
 *
 * Passthrough mode + inner Commander instance — same pattern as `tools`.
 * Live provider instantiation (calling `ProviderRegistry.create`) is M3
 * work and not done here; M2's job is purely "store + retrieve + display".
 */

import { Command, CommanderError } from 'commander'

import {
	PROVIDER_TYPES,
	ProfileValidationError,
	type ProviderProfile,
	type ProviderType,
	ProvidersStoreError,
	findDefault,
	isProviderType,
	maskSecret,
	providersPath,
	readProfiles,
	resolveApiKey,
	validateProfile,
	writeProfiles,
} from '../integrations/providers/index.js'
import type { CommandContext, CommandDef } from './types.js'

interface AddOpts {
	type: string
	apiKey?: string
	baseUrl?: string
	model?: string
	organization?: string
	project?: string
	host?: string
	region?: string
	dialect?: string
	default?: boolean
}

async function runLs(
	ctx: CommandContext,
	opts: { showSecrets?: boolean; type?: string },
): Promise<number> {
	let profiles: readonly ProviderProfile[]
	try {
		profiles = readProfiles()
	} catch (err) {
		ctx.formatter.error({
			message: err instanceof Error ? err.message : String(err),
		})
		return 70
	}
	let filtered = profiles
	if (opts.type) {
		if (!isProviderType(opts.type)) {
			ctx.formatter.error({
				message: `--type must be one of: ${PROVIDER_TYPES.join(', ')}`,
			})
			return 64
		}
		filtered = profiles.filter((p) => p.type === opts.type)
	}
	const rows = filtered.map((p) => {
		const apiKey = resolveApiKey(p)
		return {
			name: p.name,
			type: p.type,
			model: p.model ?? null,
			apiKey: opts.showSecrets ? apiKey : maskSecret(apiKey),
			default: p.default === true,
			source: keySource(p, apiKey),
		}
	})
	ctx.formatter.print({
		path: providersPath(),
		count: rows.length,
		default: findDefault(profiles)?.name ?? null,
		profiles: rows,
	})
	return 0
}

async function runAdd(ctx: CommandContext, name: string, opts: AddOpts): Promise<number> {
	if (!isProviderType(opts.type)) {
		ctx.formatter.error({
			message: `--type must be one of: ${PROVIDER_TYPES.join(', ')}`,
		})
		return 64
	}
	const type: ProviderType = opts.type
	let candidate: Record<string, unknown>
	switch (type) {
		case 'openai':
			candidate = pruneUndefined({
				name,
				type,
				apiKey: opts.apiKey,
				baseUrl: opts.baseUrl,
				model: opts.model,
				organization: opts.organization,
				project: opts.project,
				default: opts.default,
			})
			break
		case 'anthropic':
		case 'openrouter':
			candidate = pruneUndefined({
				name,
				type,
				apiKey: opts.apiKey,
				baseUrl: opts.baseUrl,
				model: opts.model,
				default: opts.default,
			})
			break
		case 'ollama':
		case 'lmstudio':
			candidate = pruneUndefined({
				name,
				type,
				host: opts.host,
				model: opts.model,
				default: opts.default,
			})
			break
		case 'bedrock':
			candidate = pruneUndefined({
				name,
				type,
				region: opts.region,
				model: opts.model,
				default: opts.default,
			})
			break
		case 'http':
			if (!opts.baseUrl) {
				ctx.formatter.error({ message: '--base-url is required for type=http' })
				return 64
			}
			candidate = pruneUndefined({
				name,
				type,
				baseUrl: opts.baseUrl,
				apiKey: opts.apiKey,
				model: opts.model,
				dialect: opts.dialect,
				default: opts.default,
			})
			break
	}
	let profile: ProviderProfile
	try {
		profile = validateProfile(candidate)
	} catch (err) {
		if (err instanceof ProfileValidationError) {
			ctx.formatter.error({ message: err.message })
			return 64
		}
		throw err
	}
	const existing = readProfiles()
	if (existing.some((p) => p.name === name)) {
		ctx.formatter.error({
			message: `profile "${name}" already exists; use \`namzu providers remove ${name}\` first`,
		})
		return 64
	}
	const merged = opts.default
		? [...existing.map((p) => ({ ...p, default: false })), profile]
		: [...existing, profile]
	try {
		writeProfiles(merged)
	} catch (err) {
		if (err instanceof ProvidersStoreError) {
			ctx.formatter.error({ message: err.message })
			return 70
		}
		throw err
	}
	ctx.formatter.info(`added profile "${name}" (${type})${opts.default ? ' as default' : ''}`)
	return 0
}

async function runRemove(ctx: CommandContext, name: string): Promise<number> {
	const existing = readProfiles()
	if (!existing.some((p) => p.name === name)) {
		ctx.formatter.error({ message: `no profile named "${name}"` })
		return 64
	}
	writeProfiles(existing.filter((p) => p.name !== name))
	ctx.formatter.info(`removed profile "${name}"`)
	return 0
}

async function runDefault(ctx: CommandContext, name: string): Promise<number> {
	const existing = readProfiles()
	if (!existing.some((p) => p.name === name)) {
		ctx.formatter.error({ message: `no profile named "${name}"` })
		return 64
	}
	const updated = existing.map((p) => ({ ...p, default: p.name === name }) as ProviderProfile)
	writeProfiles(updated)
	ctx.formatter.info(`default provider set to "${name}"`)
	return 0
}

function runPath(ctx: CommandContext): number {
	ctx.formatter.print(providersPath())
	return 0
}

function keySource(p: ProviderProfile, resolved: string | null): string {
	if (resolved === null) return 'none'
	const onDisk = (p as { apiKey?: string }).apiKey
	if (onDisk && onDisk === resolved) return 'file'
	return 'env'
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v
	}
	return out as T
}

export const providersCommand: CommandDef = {
	name: 'providers',
	description: 'Manage LLM provider profiles (stored at ~/.namzu/providers.json)',
	passThrough: true,
	async handler({ ctx, rawArgs }) {
		let exitCode = 0
		const program = new Command('providers')
			.description('Manage LLM provider profiles')
			.exitOverride()
			.helpOption('-h, --help', 'Show this help')

		program
			.command('ls')
			.description('List configured provider profiles')
			.option('--show-secrets', 'Print API keys in the clear (default: mask)')
			.option('--type <type>', `Filter by provider type (${PROVIDER_TYPES.join('|')})`)
			.action(async (opts: { showSecrets?: boolean; type?: string }) => {
				exitCode = await runLs(ctx, opts)
			})

		program
			.command('add <name>')
			.description('Persist a new provider profile')
			.requiredOption('--type <type>', `Provider type (${PROVIDER_TYPES.join('|')})`)
			.option('--api-key <key>', 'API key (also reads NAMZU_<NAME>_API_KEY / <TYPE>_API_KEY env)')
			.option('--base-url <url>', 'Override base URL (required for type=http)')
			.option('--model <model>', 'Default model identifier')
			.option('--organization <org>', 'OpenAI organization id')
			.option('--project <proj>', 'OpenAI project id')
			.option('--host <host>', 'Local server host (ollama, lmstudio)')
			.option('--region <region>', 'AWS region (bedrock)')
			.option('--dialect <dialect>', "HTTP shim dialect ('openai' | 'anthropic')")
			.option('--default', 'Mark as the default profile (unsets any prior default)')
			.action(async (name: string, opts: AddOpts) => {
				exitCode = await runAdd(ctx, name, opts)
			})

		program
			.command('remove <name>')
			.description('Drop a profile from the store')
			.action(async (name: string) => {
				exitCode = await runRemove(ctx, name)
			})

		program
			.command('default <name>')
			.description('Mark a profile as the default')
			.action(async (name: string) => {
				exitCode = await runDefault(ctx, name)
			})

		program
			.command('path')
			.description('Print the profile store path')
			.action(() => {
				exitCode = runPath(ctx)
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
			ctx.formatter.error({ message: err instanceof Error ? err.message : String(err) })
			return 70
		}
	},
}
