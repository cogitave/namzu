import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { resolveNamzuHome } from '../session/home.js'
import { withAccountLockSync } from './lock.js'
import {
	type Account,
	type AccountCredentialReaders,
	type AccountId,
	type AccountRegistry,
	AccountRegistryError,
	type AccountSource,
	CredentialWithdrawnError,
	DEFAULT_ACCOUNT_LABEL,
	type NewAccount,
	type ResolvedAccountCredential,
} from './types.js'

export const ACCOUNTS_FILE_NAME = 'accounts.json'
export const ACCOUNTS_FILE_VERSION = 1
const LABEL = /^[a-z0-9-]{1,32}$/
const CODEX_PROVIDER = 'codex'
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/

// Unknown keys are kept so a store written by a newer build survives a rewrite by this one.
const SourceSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('codex-home'), dir: z.string().min(1) }).passthrough(),
	z.object({ kind: z.literal('api-key'), keyRef: z.string().min(1) }).passthrough(),
])
const AccountSchema = z
	.object({
		id: z.string().min(1),
		provider: z.string().min(1),
		label: z.string().min(1),
		source: SourceSchema,
		createdAt: z.string(),
		display: z.string().optional(),
	})
	.passthrough()
const FileSchema = z
	.object({
		version: z.literal(ACCOUNTS_FILE_VERSION),
		accounts: z.array(AccountSchema),
		keys: z.record(z.string()),
	})
	.passthrough()
type StoreFile = z.infer<typeof FileSchema>

export interface AccountRegistryOptions {
	/** The Namzu home. Defaults to `resolveNamzuHome()`. */
	readonly home?: string
	/** Providers that always have a synthesised `default` account, even with no stored one. */
	readonly defaultProviders?: readonly string[]
	readonly readers?: AccountCredentialReaders
	readonly now?: () => Date
	/** Blocks between attempts to take the store lock. Defaults to a short real sleep. */
	readonly lockWait?: (attempt: number) => void
}

function sleepBlocking(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
}

export function accountId(provider: string, label: string): AccountId {
	return `${provider}:${label}`
}

/** Split an id into provider and label, or `undefined` if it is not shaped `<provider>:<label>`. */
export function parseAccountId(id: string): { provider: string; label: string } | undefined {
	const at = id.indexOf(':')
	if (at <= 0 || at === id.length - 1) return undefined
	return { provider: id.slice(0, at), label: id.slice(at + 1) }
}

function writeAtomic(path: string, text: string): void {
	const temporary = join(dirname(path), `.${randomBytes(8).toString('hex')}.accounts.tmp`)
	const fd = openSync(temporary, 'wx', 0o600)
	try {
		writeSync(fd, text)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	try {
		renameSync(temporary, path)
	} catch (error) {
		try {
			unlinkSync(temporary)
		} catch {
			// The rename already failed; the leftover temporary is not the failure to report.
		}
		throw error
	}
}

export function createAccountRegistry(options: AccountRegistryOptions = {}): AccountRegistry {
	const home = options.home ?? resolveNamzuHome()
	const path = join(home, ACCOUNTS_FILE_NAME)
	const lockPath = `${path}.lock`
	const accountsRoot = join(home, 'accounts')
	const now = options.now ?? (() => new Date())

	function defaultAccount(provider: string): Account {
		return {
			id: accountId(provider, DEFAULT_ACCOUNT_LABEL),
			provider,
			label: DEFAULT_ACCOUNT_LABEL,
			source: { kind: 'existing-default' },
			createdAt: new Date(0).toISOString(),
		}
	}

	function read(): StoreFile {
		let text: string
		try {
			text = readFileSync(path, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { version: ACCOUNTS_FILE_VERSION, accounts: [], keys: {} }
			}
			throw error
		}
		let json: unknown
		try {
			json = JSON.parse(text)
		} catch {
			throw new AccountRegistryError(`${path} is not valid JSON; no account was changed.`)
		}
		const parsed = FileSchema.safeParse(json)
		if (!parsed.success) {
			throw new AccountRegistryError(
				`${path} is not a version ${ACCOUNTS_FILE_VERSION} account store.`,
			)
		}
		return parsed.data
	}

	function mutate<T>(change: (file: StoreFile) => T): T {
		mkdirSync(home, { recursive: true, mode: 0o700 })
		return withAccountLockSync(
			lockPath,
			() => {
				const file = read()
				const result = change(file)
				writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`)
				try {
					chmodSync(path, 0o600)
				} catch {
					// Windows has no POSIX mode; the temporary was already created 0600 where it applies.
				}
				return result
			},
			{ attempts: 80, wait: options.lockWait ?? sleepBlocking },
		)
	}

	function ownDir(source: { kind: string; [key: string]: unknown }): string {
		return String(source.dir)
	}

	function toAccount(stored: StoreFile['accounts'][number]): Account {
		return stored as unknown as Account
	}

	function checkLabel(label: string): void {
		if (!LABEL.test(label)) {
			throw new AccountRegistryError(
				'An account label is 1 to 32 characters: lowercase letters, digits and hyphens.',
			)
		}
		if (label === DEFAULT_ACCOUNT_LABEL) {
			throw new AccountRegistryError('The label "default" belongs to the existing sign-in.')
		}
	}

	function realOrSelf(target: string): string {
		// Resolve symlinks through the deepest existing ancestor, so a symlinked
		// parent cannot lead outside the accounts folder.
		let existing = resolve(target)
		const rest: string[] = []
		for (;;) {
			try {
				return join(realpathSync(existing), ...rest.reverse())
			} catch {
				const parent = dirname(existing)
				if (parent === existing) return resolve(target)
				rest.push(basename(existing))
				existing = parent
			}
		}
	}

	function insideAccountsRoot(dir: string): boolean {
		const rel = relative(realOrSelf(accountsRoot), realOrSelf(dir))
		return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
	}

	function nests(outer: string, inner: string): boolean {
		const rel = relative(realOrSelf(outer), realOrSelf(inner))
		return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
	}

	const registry: AccountRegistry = {
		list(provider) {
			const stored = read().accounts.map(toAccount)
			const providers = new Set<string>([
				...(options.defaultProviders ?? []),
				...stored.map((a) => a.provider),
			])
			if (provider !== undefined) providers.add(provider)
			const defaults = [...providers]
				.filter((p) => provider === undefined || p === provider)
				.map(defaultAccount)
			return [
				...defaults,
				...stored.filter((a) => provider === undefined || a.provider === provider),
			]
		},

		get(id) {
			const parsed = parseAccountId(id)
			if (!parsed) return undefined
			if (parsed.label === DEFAULT_ACCOUNT_LABEL) return defaultAccount(parsed.provider)
			const stored = read().accounts.find((a) => a.id === id)
			return stored ? toAccount(stored) : undefined
		},

		add(input: NewAccount) {
			if (!PROVIDER.test(input.provider)) {
				throw new AccountRegistryError('The provider name is not valid.')
			}
			checkLabel(input.label)
			const id = accountId(input.provider, input.label)
			return mutate((file) => {
				if (file.accounts.some((a) => a.id === id)) {
					throw new AccountRegistryError(`There is already an account labelled "${input.label}".`)
				}
				let source: AccountSource
				if (input.kind === 'api-key') {
					if (input.apiKey.length === 0) throw new AccountRegistryError('The API key is empty.')
					const keyRef = `key-${randomBytes(9).toString('hex')}`
					file.keys[keyRef] = input.apiKey
					source = { kind: 'api-key', keyRef }
				} else {
					if ((input as { provider: string }).provider !== CODEX_PROVIDER) {
						throw new AccountRegistryError(
							'A Codex home account belongs to the codex provider only.',
						)
					}
					const dir = resolve(input.dir ?? join(accountsRoot, 'codex', input.label))
					if (!insideAccountsRoot(dir)) {
						throw new AccountRegistryError(
							'A Codex account directory must live under the Namzu accounts folder.',
						)
					}
					if (
						file.accounts.some(
							(a) =>
								a.source.kind === 'codex-home' &&
								(nests(a.source.dir, dir) || nests(dir, a.source.dir)),
						)
					) {
						throw new AccountRegistryError(
							'Another account already uses that Codex directory, or one inside or around it.',
						)
					}
					mkdirSync(dir, { recursive: true, mode: 0o700 })
					source = { kind: 'codex-home', dir }
				}
				const account: Account = {
					id,
					provider: input.provider,
					label: input.label,
					source,
					createdAt: now().toISOString(),
					...(input.display !== undefined ? { display: input.display } : {}),
				}
				file.accounts.push(account as unknown as StoreFile['accounts'][number])
				return account
			})
		},

		rename(id, label) {
			checkLabel(label)
			return mutate((file) => {
				const index = file.accounts.findIndex((a) => a.id === id)
				const current = file.accounts[index]
				if (!current) throw new AccountRegistryError('No such account.')
				const nextId = accountId(current.provider, label)
				if (file.accounts.some((a) => a.id === nextId)) {
					throw new AccountRegistryError(`There is already an account labelled "${label}".`)
				}
				const renamed = { ...current, id: nextId, label }
				file.accounts[index] = renamed
				return toAccount(renamed)
			})
		},

		remove(id) {
			const parsed = parseAccountId(id)
			if (parsed?.label === DEFAULT_ACCOUNT_LABEL) {
				throw new AccountRegistryError(
					'The existing sign-in is not an account that can be removed.',
				)
			}
			mutate((file) => {
				const index = file.accounts.findIndex((a) => a.id === id)
				const current = file.accounts[index]
				if (!current) throw new AccountRegistryError('No such account.')
				file.accounts.splice(index, 1)
				if (current.source.kind === 'api-key') {
					delete file.keys[current.source.keyRef]
				} else if (
					insideAccountsRoot(ownDir(current.source)) &&
					!file.accounts.some(
						(a) => a.source.kind === 'codex-home' && nests(ownDir(current.source), a.source.dir),
					)
				) {
					// Only a directory this registry could have created, and that holds no
					// other account's directory, is ever deleted.
					rmSync(ownDir(current.source), { recursive: true, force: true })
				}
			})
		},

		async resolve(id, signal): Promise<ResolvedAccountCredential> {
			const account = registry.get(id)
			if (!account) throw new CredentialWithdrawnError(id, 'That account no longer exists.')
			const { source } = account
			if (source.kind === 'existing-default') {
				if (!options.readers?.existingDefault) {
					throw new CredentialWithdrawnError(
						id,
						'No reader is configured for the existing sign-in.',
					)
				}
				return options.readers.existingDefault(account.provider, signal)
			}
			if (source.kind === 'codex-home') {
				if (account.provider !== CODEX_PROVIDER) {
					throw new CredentialWithdrawnError(
						id,
						'A Codex home is only valid for the codex provider.',
					)
				}
				if (!options.readers?.codexHome) {
					throw new CredentialWithdrawnError(id, 'No reader is configured for Codex accounts.')
				}
				return options.readers.codexHome(
					account as Account & { source: { kind: 'codex-home'; dir: string } },
					signal,
				)
			}
			const secret = read().keys[source.keyRef]
			if (secret === undefined) {
				throw new CredentialWithdrawnError(id, 'The saved key for this account is missing.')
			}
			return { kind: 'api-key', accessToken: secret }
		},

		next(provider, excluding) {
			return registry.list(provider).find((a) => !excluding.includes(a.id))
		},
	}
	return registry
}
