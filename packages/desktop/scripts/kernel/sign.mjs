// Sign a manifest (specification 3.5, 4.4): Ed25519 over the exact bytes of the manifest file.
//
//   NAMZU_KERNEL_SIGNING_KEY=<PKCS#8 PEM, or base64 of it> node scripts/kernel/sign.mjs <manifest.json>
//        [--out <manifest.json.sig>] [--keys packages/desktop/kernel-keys.json] [--key-id k1]
//
// The key is read from the environment only: never from a file or an argument, never written, never
// printed. The key id is the one the public key list gives to the public half of this key; --key-id
// overrides it. Writes <manifest>.sig by default.
import { readFileSync, writeFileSync } from 'node:fs'
import { isMain, parseFlags, runMain } from './cli.mjs'
import {
	DEFAULT_KEYS_FILE,
	SIGNING_KEY_ENV,
	SigningError,
	keyIdFor,
	privateKeyFromEnv,
	readKeyList,
	signManifest,
} from './signing.mjs'

/** Sign `manifestPath`; returns `{ out, keyId }`. */
export function signFile({
	manifestPath,
	out = `${manifestPath}.sig`,
	keysPath = DEFAULT_KEYS_FILE,
	keyId,
	env = process.env,
}) {
	const privateKey = privateKeyFromEnv(env)
	const id = keyId ?? keyIdFor(privateKey, readKeyList(keysPath))
	if (!id)
		throw new SigningError(
			`The key in ${SIGNING_KEY_ENV} is not in the public key list ${keysPath}; add its public key there, or name an id with --key-id.`,
		)
	writeFileSync(out, signManifest(readFileSync(manifestPath), privateKey, id))
	return { out, keyId: id }
}

async function main(args) {
	const { flags, positional } = parseFlags(args, {
		out: 'string',
		keys: 'string',
		'key-id': 'string',
	})
	if (positional.length !== 1)
		throw new Error(
			'Usage: sign.mjs <manifest.json> [--out <file>] [--keys <file>] [--key-id <id>]',
		)
	const { out, keyId } = signFile({
		manifestPath: positional[0],
		out: flags.out,
		keysPath: flags.keys,
		keyId: flags['key-id'],
	})
	console.log(`Signed ${positional[0]} with the key "${keyId}": ${out}`)
}

if (isMain(import.meta.url)) await runMain(main)
