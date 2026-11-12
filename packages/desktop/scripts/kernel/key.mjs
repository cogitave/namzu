// Make a signing key pair (specification 4.6).
//
//   node scripts/kernel/key.mjs [--id k1]                 print the public entry; the private half is thrown away
//   node scripts/kernel/key.mjs [--id k1] --private       write ONLY the PKCS#8 PEM to standard output
//
// With --private nothing else goes to standard output, so it can be piped straight into a secret store:
//   node scripts/kernel/key.mjs --id k1 --private | gh secret set NAMZU_KERNEL_SIGNING_KEY --env kernel-release
// The public entry then goes to standard error, to be pasted into packages/desktop/kernel-keys.json.
// The private key is never written to a file by this command, and standard output must not be a terminal
// (scrollback keeps it) unless --allow-tty says it is meant.
import { isMain, parseFlags, runMain } from './cli.mjs'
import { makeKeyPair } from './signing.mjs'

async function main(args) {
	const { flags } = parseFlags(args, { id: 'string', private: 'boolean', 'allow-tty': 'boolean' })
	const { privatePem, entry } = makeKeyPair(flags.id ?? 'k1')
	if (!flags.private) {
		process.stderr.write(
			'Only the public entry is shown; this private key is discarded. Use --private to keep one.\n',
		)
		console.log(JSON.stringify(entry))
		return
	}
	if (process.stdout.isTTY && !flags['allow-tty'])
		throw new Error(
			'Standard output is a terminal; pipe it into a secret store instead (or pass --allow-tty to print the key here).',
		)
	process.stderr.write(
		`Public entry for packages/desktop/kernel-keys.json: ${JSON.stringify(entry)}\n`,
	)
	process.stdout.write(privatePem)
}

if (isMain(import.meta.url)) await runMain(main)
