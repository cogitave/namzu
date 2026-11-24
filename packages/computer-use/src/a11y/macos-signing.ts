import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { runCommand } from '../util/spawn.js'

/**
 * A code-signing identity that belongs to this person's Namzu home and to
 * nothing else.
 *
 * Why: macOS keeps the Accessibility switch (on macOS 27 it is named "Device
 * Control and Data Access") against the *designated requirement* of the
 * signed app. An ad-hoc signature has none that survives a rebuild (it is the
 * code's own hash), and macOS 27 does not trust an ad-hoc app at all, even
 * with its switch on. A self-signed identity gives the requirement
 * `identifier "com.namzu.helper" and certificate leaf = H"<sha1>"`, which is
 * the same for every build signed with it, so the grant is made once and
 * outlives rebuilds.
 *
 * The identity lives in a keychain of its own, never in the login keychain:
 * `<NAMZU_HOME>/computer-use/macos/signing/namzu-signing.keychain-db`, opened
 * with a random password kept 0600 next to it (`kc.pw`). The certificate
 * (public) is kept as `cert.pem`; the private key is imported and the loose
 * key files are removed. Nothing here needs sudo or touches the system trust
 * settings.
 */

export const SIGNING_KEYCHAIN = 'namzu-signing.keychain-db'
export const SIGNING_PASSWORD_FILE = 'kc.pw'
export const SIGNING_CERT = 'cert.pem'
export const SIGNING_COMMON_NAME = 'Namzu Helper Local Signing'

type Run = typeof runCommand

export interface MacSigningIdentity {
	/** Absolute path of the dedicated keychain. */
	readonly keychain: string
	/** The keychain's password. */
	readonly password: string
	/** The certificate's SHA-1, upper-case hex: what `codesign --sign` takes. */
	readonly identity: string
}

export function macSigningDir(root: string): string {
	return join(root, 'signing')
}

const OPENSSL_CONFIG = `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=${SIGNING_COMMON_NAME}
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
`

/** `SHA1 Fingerprint=AA:BB:…` (or `sha1 Fingerprint=`) → `AABB…`. */
export function parseFingerprint(output: string): string | undefined {
	const match = /sha1 fingerprint=([0-9a-f:]+)/i.exec(output)
	const hex = match?.[1]?.replace(/:/g, '').toUpperCase()
	return hex && /^[0-9A-F]{40}$/.test(hex) ? hex : undefined
}

function userKeychains(output: string): string[] {
	return [...output.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
}

async function identityFrom(
	dir: string,
	run: Run,
	env: NodeJS.ProcessEnv,
): Promise<MacSigningIdentity | undefined> {
	const keychain = join(dir, SIGNING_KEYCHAIN)
	const cert = join(dir, SIGNING_CERT)
	const passwordFile = join(dir, SIGNING_PASSWORD_FILE)
	if (!existsSync(keychain) || !existsSync(cert) || !existsSync(passwordFile)) return undefined
	const result = await run('openssl', ['x509', '-in', cert, '-noout', '-fingerprint', '-sha1'], {
		timeoutMs: 15_000,
		env,
	}).catch(() => undefined)
	const identity =
		result && result.exitCode === 0 ? parseFingerprint(result.stdout.toString('utf8')) : undefined
	if (!identity) return undefined
	// The files can all be there while the keychain is gone, corrupt or holds another key.
	const listed = await run('security', ['find-identity', '-p', 'codesigning', keychain], {
		timeoutMs: 15_000,
		env,
	}).catch(() => undefined)
	if (
		!listed ||
		listed.exitCode !== 0 ||
		!listed.stdout.toString('utf8').toUpperCase().includes(identity)
	)
		return undefined
	return { keychain, password: readFileSync(passwordFile, 'utf8').trim(), identity }
}

/** The system openssl on a Mac (LibreSSL, which `security import` reads); a bare name elsewhere. */
function opensslCommand(): string {
	return process.platform === 'darwin' && existsSync('/usr/bin/openssl')
		? '/usr/bin/openssl'
		: 'openssl'
}

/** OpenSSL 3 writes a PKCS#12 that `security import` cannot read unless the old algorithms are asked for. */
async function pkcs12Compat(run: Run, env: NodeJS.ProcessEnv, openssl: string): Promise<string[]> {
	const version = await run(openssl, ['version'], { timeoutMs: 15_000, env }).catch(() => undefined)
	return version && /OpenSSL 3\./.test(version.stdout.toString('utf8'))
		? ['-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']
		: []
}

async function must(run: Run, env: NodeJS.ProcessEnv, command: string, args: readonly string[]) {
	const result = await run(command, args, { timeoutMs: 60_000, env })
	if (result.exitCode !== 0)
		throw new Error(`${command} ${args[0] ?? ''} failed: ${result.stderr.trim().slice(0, 300)}`)
	return result
}

/**
 * The identity for this Namzu home: the existing one, or a new one made once.
 * Resolves `undefined` (with the reason in `onFailure`) when it cannot be
 * made, so the caller can fall back to an ad-hoc signature.
 */
export async function ensureSigningIdentity(options: {
	readonly root: string
	readonly env: NodeJS.ProcessEnv
	readonly run?: Run
	readonly onFailure?: (reason: string) => void
	/** Called when an identity that was there could not be used and was set aside; the grant must be given again. */
	readonly onBroken?: () => void
}): Promise<MacSigningIdentity | undefined> {
	const run = options.run ?? runCommand
	const dir = macSigningDir(options.root)
	const existing = await identityFrom(dir, run, options.env)
	if (existing) return existing
	if (existsSync(dir)) {
		// Files without a working keychain: keep them for inspection and make a new identity.
		try {
			renameSync(dir, `${dir}.broken-${Date.now()}`)
			options.onBroken?.()
		} catch {
			// Another process moved it first; what is there now is tried below.
		}
	}
	const stage = join(options.root, `signing-make-${process.pid}-${randomBytes(4).toString('hex')}`)
	const openssl = opensslCommand()
	try {
		mkdirSync(stage, { recursive: true, mode: 0o700 })
		const password = randomBytes(24).toString('hex')
		const config = join(stage, 'cs.cnf')
		const keyFile = join(stage, 'key.pem')
		const certFile = join(stage, SIGNING_CERT)
		const p12 = join(stage, 'id.p12')
		const passwordFile = join(stage, SIGNING_PASSWORD_FILE)
		const keychain = join(stage, SIGNING_KEYCHAIN)
		writeFileSync(config, OPENSSL_CONFIG, { mode: 0o600 })
		writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 })
		chmodSync(passwordFile, 0o600)
		await must(run, options.env, openssl, [
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyFile,
			'-out',
			certFile,
			'-days',
			'3650',
			'-config',
			config,
		])
		chmodSync(keyFile, 0o600)
		await must(run, options.env, openssl, [
			'pkcs12',
			'-export',
			'-inkey',
			keyFile,
			'-in',
			certFile,
			'-out',
			p12,
			'-passout',
			`file:${passwordFile}`,
			...(await pkcs12Compat(run, options.env, openssl)),
		])
		const listed = await run('security', ['list-keychains', '-d', 'user'], {
			timeoutMs: 15_000,
			env: options.env,
		}).catch(() => undefined)
		const before = listed ? userKeychains(listed.stdout.toString('utf8')) : []
		await must(run, options.env, 'security', ['create-keychain', '-p', password, keychain])
		// create-keychain may add the new keychain to the person's search list; put the list back as it was.
		if (before.length > 0)
			await run('security', ['list-keychains', '-d', 'user', '-s', ...before], {
				timeoutMs: 15_000,
				env: options.env,
			}).catch(() => undefined)
		await must(run, options.env, 'security', ['set-keychain-settings', '-t', '300', '-l', keychain])
		await must(run, options.env, 'security', ['unlock-keychain', '-p', password, keychain])
		await must(run, options.env, 'security', [
			'import',
			p12,
			'-k',
			keychain,
			'-P',
			password,
			'-T',
			'/usr/bin/codesign',
		])
		await must(run, options.env, 'security', [
			'set-key-partition-list',
			'-S',
			'apple-tool:,apple:',
			'-s',
			'-k',
			password,
			keychain,
		])
		await lockSigningKeychain(keychain, options.env, run)
		// The private key is in the keychain now; the loose copies go.
		rmSync(keyFile, { force: true })
		rmSync(p12, { force: true })
		rmSync(config, { force: true })
		chmodSync(passwordFile, 0o600)
		// One step: the whole folder appears at once or, when another process was first, not at all.
		mkdirSync(options.root, { recursive: true, mode: 0o700 })
		try {
			renameSync(stage, dir)
		} catch {
			// The other process's identity is used if it works.
		}
		return await identityFrom(dir, run, options.env)
	} catch (error) {
		options.onFailure?.(error instanceof Error ? error.message : String(error))
		return undefined
	} finally {
		rmSync(stage, { recursive: true, force: true })
	}
}

/** Opens the identity's keychain; codesign cannot ask for a password. */
export async function unlockSigningKeychain(
	identity: MacSigningIdentity,
	env: NodeJS.ProcessEnv,
	run: Run = runCommand,
): Promise<boolean> {
	const result = await run(
		'security',
		['unlock-keychain', '-p', identity.password, identity.keychain],
		{
			timeoutMs: 15_000,
			env,
		},
	).catch(() => undefined)
	return result?.exitCode === 0
}

/** Closes the keychain again; the private key is only needed while codesign runs. */
export async function lockSigningKeychain(
	keychain: string,
	env: NodeJS.ProcessEnv,
	run: Run = runCommand,
): Promise<void> {
	await run('security', ['lock-keychain', keychain], { timeoutMs: 15_000, env }).catch(
		() => undefined,
	)
}
