import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * An Entra bearer token for an Azure resource, for a decision model that is
 * configured without a key.
 *
 * `AZURE_FOUNDRY_TOKEN` (or the variable the config names) wins when it is set,
 * because a person who exports a token means that one and it costs no process.
 * Otherwise the Azure CLI is asked, once, and the answer is kept until five
 * minutes before it expires. A failure is an empty string, which the driver
 * turns into its own "no credential" error; nothing here throws.
 */

export const AZURE_TOKEN_RESOURCE = 'https://cognitiveservices.azure.com'
export const DEFAULT_TOKEN_ENV = 'AZURE_FOUNDRY_TOKEN'
/** A cached token is dropped this long before the service would refuse it. */
export const TOKEN_EARLY_EXPIRY_MS = 5 * 60 * 1000
const AZ_TIMEOUT_MS = 15_000

export type RunAz = (command: string, args: readonly string[]) => Promise<string>

export interface AzureTokenDeps {
	readonly env: NodeJS.ProcessEnv
	readonly now?: () => number
	readonly runAz?: RunAz
	readonly findAz?: (env: NodeJS.ProcessEnv) => string | undefined
}

/** The `az` executable on PATH, or undefined. */
export function findAzOnPath(env: NodeJS.ProcessEnv): string | undefined {
	const path = env.PATH ?? env.Path ?? ''
	const names = process.platform === 'win32' ? ['az.cmd', 'az.exe', 'az.bat'] : ['az']
	for (const dir of path.split(delimiter)) {
		if (!dir) continue
		for (const name of names) {
			const candidate = join(dir, name)
			if (existsSync(candidate)) return candidate
		}
	}
	return undefined
}

const defaultRunAz: RunAz = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{ timeout: AZ_TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		)
	})

/** `{ accessToken, expires_on | expiresOn }` as `az account get-access-token` prints it. */
export function parseAzTokenOutput(
	output: string,
): { token: string; expiresAt: number } | undefined {
	try {
		const parsed = JSON.parse(output) as Record<string, unknown>
		const token = parsed.accessToken
		if (typeof token !== 'string' || token.length === 0) return undefined
		const epoch = parsed.expires_on
		let expiresAt: number | undefined
		if (typeof epoch === 'number') expiresAt = epoch * 1000
		else if (typeof epoch === 'string' && /^\d+$/.test(epoch)) expiresAt = Number(epoch) * 1000
		else if (typeof parsed.expiresOn === 'string') {
			const ms = Date.parse(parsed.expiresOn.replace(' ', 'T'))
			if (!Number.isNaN(ms)) expiresAt = ms
		}
		return expiresAt === undefined ? undefined : { token, expiresAt }
	} catch {
		return undefined
	}
}

/**
 * A token source with its own cache. `tokenEnv` is the variable the config
 * named, or the default. A concurrent call shares the one `az` run.
 */
export function createAzureTokenSource(
	tokenEnv: string | undefined,
	deps: AzureTokenDeps,
): () => Promise<string> {
	const now = deps.now ?? Date.now
	const runAz = deps.runAz ?? defaultRunAz
	const findAz = deps.findAz ?? findAzOnPath
	let cached: { token: string; expiresAt: number } | undefined
	let inflight: Promise<string> | undefined

	const fromAz = async (): Promise<string> => {
		const az = findAz(deps.env)
		if (!az) return ''
		try {
			const output = await runAz(az, [
				'account',
				'get-access-token',
				'--resource',
				AZURE_TOKEN_RESOURCE,
				'--output',
				'json',
			])
			const parsed = parseAzTokenOutput(output)
			if (!parsed) return ''
			cached = parsed
			return parsed.token
		} catch {
			return ''
		}
	}

	return async () => {
		const fromEnv = deps.env[tokenEnv ?? DEFAULT_TOKEN_ENV]
		if (fromEnv) return fromEnv
		// A config that names its variable means that variable only.
		if (tokenEnv !== undefined) return ''
		if (cached && now() < cached.expiresAt - TOKEN_EARLY_EXPIRY_MS) return cached.token
		inflight ??= fromAz().finally(() => {
			inflight = undefined
		})
		return inflight
	}
}
