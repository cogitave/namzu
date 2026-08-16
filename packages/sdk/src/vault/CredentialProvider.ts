import { isCredentialEnvKey } from '../constants/credential-env-keys.js'
import { NamzuError } from '../types/errors/index.js'

/**
 * Where a credential comes from, as a seam a host can implement.
 *
 * Parallel to `CredentialVault`, not a replacement for it. That interface is
 * connector-scoped — it holds a whole `AuthConfig` for a named connector —
 * and its only implementation keeps them in a `Map`, in-process, with no
 * persistence and no notion of writability. This is the other question: given
 * a variable name, who can answer what it is, and can anybody change it.
 *
 * It exists because all LLM-provider credential discovery lived in the CLI,
 * which walks a provider registry and reads `process.env` itself. A host
 * embedding the SDK without the CLI therefore had no way to plug in an env-
 * or file-backed source short of reimplementing the vault interface for a
 * question the vault does not ask.
 */

/** A credential's name — an environment variable, a keychain entry, a path. */
export type CredentialRef = string

export interface ResolvedCredential {
	readonly value: string
	/** Which backing store answered. Named so a host can say where it looked. */
	readonly source: string
}

export interface CredentialDescription {
	readonly configured: boolean
	/** Absent when nothing has it — there is no source to name. */
	readonly source?: string
	/**
	 * Whether `set`/`unset` will do anything.
	 *
	 * Reported rather than discovered by trying, because the discovery is a
	 * write. A caller that has to attempt a mutation to learn it is not
	 * allowed has already attempted it somewhere that permits it.
	 */
	readonly writable: boolean
}

export interface CredentialProvider {
	resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
	/**
	 * What is known about a credential WITHOUT returning it.
	 *
	 * Never carries the value. A "does this exist" question is asked in
	 * places a secret must not travel to — a doctor readout, a picker, a log
	 * line — and a description that carried one would leak on every one of
	 * them while looking like metadata.
	 */
	describe(ref: CredentialRef): Promise<CredentialDescription>
	set(ref: CredentialRef, value: string): Promise<void>
	unset(ref: CredentialRef): Promise<void>
}

/** A write attempted against a provider that cannot perform one. */
export class ReadOnlyCredentialProviderError extends NamzuError {
	constructor(ref: CredentialRef, source: string, alternative: string) {
		super({
			code: 'invalid_config',
			message: `${source} cannot store credentials: "${ref}" is read from the process environment, which this process does not own. ${alternative}`,
			details: { ref, source },
			retryable: false,
		})
		this.name = 'ReadOnlyCredentialProviderError'
	}
}

export interface EnvCredentialProviderOptions {
	/** The environment to read. Injectable so a test needs no global. */
	readonly env?: NodeJS.ProcessEnv
	/**
	 * Answer for any name, not only credential-shaped ones.
	 *
	 * Off by default. A provider that resolves ANY variable is a way to read
	 * arbitrary process state through a seam whose name says "credential",
	 * and the caller asking for `HOME` through a credential provider has
	 * asked the wrong object.
	 */
	readonly anyKey?: boolean
}

/**
 * Credentials from the process environment.
 *
 * Read-only, and it says so rather than accepting a write and dropping it.
 * `process.env` is inherited from whoever started this process; a `set` here
 * would change one map in one process and vanish with it, while every
 * caller who asked would be told it worked. That is the quiet degradation
 * this repo has a rule about, and for a credential the failure surfaces
 * later as an authentication error pointing nowhere.
 */
export class EnvCredentialProvider implements CredentialProvider {
	static readonly source = 'env'

	private readonly env: NodeJS.ProcessEnv
	private readonly anyKey: boolean

	constructor(options: EnvCredentialProviderOptions = {}) {
		this.env = options.env ?? process.env
		this.anyKey = options.anyKey ?? false
	}

	private answers(ref: CredentialRef): boolean {
		return this.anyKey || isCredentialEnvKey(ref)
	}

	async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
		if (!this.answers(ref)) return undefined
		const value = this.env[ref]
		// An empty string is not a credential. A variable exported as `FOO=`
		// is the shape a shell script produces when a lookup failed, and
		// treating it as present sends a caller off to authenticate with
		// nothing.
		return value ? { value, source: EnvCredentialProvider.source } : undefined
	}

	async describe(ref: CredentialRef): Promise<CredentialDescription> {
		const found = await this.resolve(ref)
		return {
			configured: found !== undefined,
			...(found ? { source: found.source } : {}),
			writable: false,
		}
	}

	// Takes the value it will not store, so the signature reads as the
	// interface's and a caller does not have to discover the refusal by
	// getting an arity error instead of the named one.
	async set(ref: CredentialRef, _value: string): Promise<void> {
		throw new ReadOnlyCredentialProviderError(
			ref,
			EnvCredentialProvider.source,
			'Set it in the environment this process is started from, or supply a writable CredentialProvider.',
		)
	}

	async unset(ref: CredentialRef): Promise<void> {
		throw new ReadOnlyCredentialProviderError(
			ref,
			EnvCredentialProvider.source,
			'Unset it in the environment this process is started from, or supply a writable CredentialProvider.',
		)
	}
}
