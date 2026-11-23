import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import { discoverProviders } from '../integrations/providers/discover.js'
import { AUTH_ACTIONS } from './actions/auth.js'
import { authStatusRows, renderAuthStatus } from './auth-status.js'
import { loginCommand, logoutCommand } from './login.js'
import type { CommandDef } from './types.js'

const HELP = [
	'Usage:',
	'  namzu auth login <claude|codex> [--no-browser] [--code <value>] [--timeout <seconds>]',
	'  namzu auth logout [claude|codex|gemini|<provider>|all]',
	'  namzu auth status [--json]',
	'',
	'Sign in with a provider subscription, sign out, and see which credentials',
	'this machine has.',
	'',
	'login options:',
	'  --no-browser        Do not try to launch a browser; just print the address.',
	'  --code <value>      Finish a Claude sign-in that is waiting for its code: the code,',
	'                      code#state, or the finished address (within 10 minutes).',
	'  --timeout <seconds> Give up waiting after this long (default: 300).',
	'',
	'Claude sign-in opens a registered browser flow; paste the returned code or',
	'finished address into this terminal. Where the shell cannot take a paste',
	'(standard input closed), the sign-in is kept for 10 minutes, the address is',
	'printed, and you finish with: namzu auth login claude --code <code>.',
	'Codex sign-in prints a device code and polls while you approve it in the browser.',
	'Exit status: 0 signed in, or waiting for the code; 1 the sign-in failed; 2 the',
	'command was used wrongly.',
	'',
	'logout removes the credentials Namzu stored on this machine (all of them when',
	'no provider is named). Credentials another tool owns, or that come from the',
	'environment, are left alone.',
	'',
	'status lists each stored or detected credential: provider, where it comes from,',
	'its kind (subscription sign-in, API key, environment variable) and whether it',
	'is usable or expired. It never prints a token or key. Exit status: 0 when at',
	'least one credential is usable, 1 when none is.',
	'  --json              Print the same list as a JSON array.',
	'',
	'The credential is written to ~/.namzu/credentials.json, readable only by your',
	'account.',
	'',
	'Inside WSL, a Claude or Codex sign-in made in Namzu Desktop on Windows is used in',
	'place when this terminal has none of its own; signing in here keeps a separate one.',
	'',
	'  -h, --help          Show this help.',
].join('\n')

export interface AuthCommandDeps {
	readonly discover: () => ReturnType<typeof discoverProviders>
	readonly now?: () => number
}

export function createAuthCommand(deps: AuthCommandDeps): CommandDef {
	return {
		name: 'auth',
		description: 'Sign in or out of a provider, and see which credentials are stored',
		passThrough: true,
		help: HELP,
		actions: AUTH_ACTIONS,
		handler: async ({ ctx, rawArgs }) => {
			const [action, ...rest] = rawArgs
			if (action === 'login') return loginCommand.handler({ ctx, rawArgs: rest })
			if (action === 'logout') return logoutCommand.handler({ ctx, rawArgs: rest })
			if (action === 'status') {
				const unknown = rest.find((arg) => arg !== '--json')
				if (unknown !== undefined) {
					ctx.formatter.error({ message: 'Usage: namzu auth status [--json]' })
					return EXIT_USAGE
				}
				const rows = authStatusRows(await deps.discover(), deps.now?.())
				if (rest.includes('--json')) {
					process.stdout.write(`${JSON.stringify(rows)}\n`)
				} else {
					ctx.formatter.print({ credentials: rows, text: renderAuthStatus(rows) })
				}
				// 1: nothing usable. The list above says why (none found, or all expired).
				return rows.some((row) => row.state === 'usable') ? EXIT_OK : EXIT_FAIL
			}
			ctx.formatter.error({ message: 'Usage: namzu auth <login|logout|status>' })
			return EXIT_USAGE
		},
	}
}

export const authCommand: CommandDef = createAuthCommand({
	// Local servers are not credentials, so nothing here probes the network.
	discover: () => discoverProviders({ skipProbes: true }),
})
