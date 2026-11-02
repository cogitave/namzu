import { spawn } from 'node:child_process'
import { openCliAccounts, storedAccountSignedIn } from '../integrations/accounts/open.js'
import { SpacesHost } from '../spaces/host.js'
import type { ConversationQuery, HostAccount, SessionRequest } from '../spaces/host.js'
import { type MouseMode, resolveMouseMode } from '../spaces/mouse.js'
import { advertisesTruecolor } from '../spaces/palette.js'
import { createPeerSource } from '../spaces/peers.js'
import type { PeerSource } from '../spaces/peers.js'
import { DEFAULT_PREFIX, parsePrefix } from '../spaces/prefix.js'
import type { SessionSpec } from '../spaces/session.js'
import { type SpacesStore, fileStore, spacesFilePath } from '../spaces/store.js'
import { type HostPtyModule, buildPtyEnv, loadHostPty } from '../terminal/pty.js'
import type { CommandDef } from './types.js'

export const SPACES_HELP = `Usage: namzu spaces [options]

(preview) Run Namzu sessions side by side. The sidebar lists your spaces (project
folders) on top, each with one dot for the most urgent thing in it, and the sessions
of the selected space below. Beside it the space shows a tab bar and, under it, the
tab's panes: each pane is a full Namzu in its own terminal, so one that stops does not
affect the others. The options after "spaces" go to the first session, so
"namzu spaces --model <name>" starts it on that model.

Dots: red needs approval, blue finished and not seen yet, yellow working, green idle.

Keys (press ctrl+b first; change it with tui.spacesPrefix in your config):
  ctrl+b            send a literal ctrl+b to the session (press it twice)
  v / -             split the pane side by side / top over bottom
  h j k l           focus the pane left, below, above, right
  H J K L           swap the pane with its neighbour in that direction
  tab / shift+tab   next / previous pane
  x                 close the pane (the last pane closes the tab)
  z                 zoom the pane, or bring the layout back
  r                 resize mode: h/l width, j/k height, esc done
  c / T / X         new tab / rename tab / close tab
  n / p, 1-9        next / previous tab, tab by number
  N / W / D         new space from a folder / rename space / close space
  P                 rename the pane
  w                 sidebar: up/down to pick a session, right to open it full screen,
                    enter to type in it, esc to leave
  b                 hide or show the sidebar
  q                 quit

In a session, press the left arrow on an empty message box to come back to the
sidebar (from full screen it returns to this screen; from a pane it moves the keys to
the sidebar). The same arrow in a plain "namzu" opens this screen with the
conversation as one of the panes.

Your spaces, tabs and panes are remembered. Start "namzu spaces" again and they come
back listed; each session starts, and resumes its conversation, when you first open its
tab. A conversation that is open in another terminal is not opened a second time.
Closing a pane removes it from the layout but keeps the conversation: "namzu resume"
reaches it.

The mouse works too: click a pane to focus it, a tab to open it, "+" to add a tab, a
space or a session in the sidebar; drag a border between panes to resize them; scroll
the sidebar, or the history of the pane under the pointer.
`

export interface SpacesDeps {
	readonly stdin: NodeJS.ReadStream
	readonly stdout: NodeJS.WriteStream
	readonly stderr: { write(text: string): unknown }
	readonly env: NodeJS.ProcessEnv
	readonly cwd: string
	readonly entry: string
	readonly loadPty: () => Promise<HostPtyModule>
	/** Where the layout is remembered; the file under the Namzu home by default. */
	readonly store?: SpacesStore
	/** The accounts a new session can start on. */
	readonly accounts?: () => readonly HostAccount[]
	/** Whether a conversation is open in another terminal; the real check reads live records and the writer lease. */
	readonly inUseElsewhere?: (query: ConversationQuery) => Promise<boolean>
	/** Runs one plain session on this terminal and resolves with its exit code. */
	readonly runPlain: (file: string, args: string[]) => Promise<number>
}

export function realDeps(): SpacesDeps {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		cwd: process.cwd(),
		entry: process.argv[1] as string,
		loadPty: () => loadHostPty(),
		runPlain: (file, args) =>
			new Promise((resolve) => {
				const child = spawn(file, args, { stdio: 'inherit' })
				child.on('error', () => resolve(1))
				child.on('exit', (code) => resolve(code ?? 1))
			}),
	}
}

/** The accounts a session can start on: those added with /auth, signed in, other than the usual sign-in. */
export function storedAccounts(): readonly HostAccount[] {
	try {
		const { registry } = openCliAccounts({ defaultProviders: [] })
		return registry
			.list()
			.filter((account) => storedAccountSignedIn(account))
			.map((account) => ({
				id: account.id,
				label: account.label,
				provider: account.provider,
				...(account.source.kind === 'codex-home' ? { codexHome: account.source.dir } : {}),
			}))
	} catch {
		return []
	}
}

/**
 * What to run for one session. A restored session reopens its conversation on the
 * account it last ran on (the conversation's own record can be a switch behind); a
 * new one names the account it was started on. A
 * session on a Codex account gets that account's home in its environment, so the
 * tools it runs sign in as that account too.
 */
export function sessionSpec(
	request: SessionRequest,
	deps: Pick<SpacesDeps, 'env' | 'entry'>,
	accounts: readonly HostAccount[],
	args: readonly string[],
): SessionSpec {
	const byId = request.account ? accounts.find((a) => a.id === request.account) : undefined
	const byLabel = request.accountLabel
		? accounts.filter((a) => a.label === request.accountLabel && a.codexHome)
		: []
	const home = (byId ?? (byLabel.length === 1 ? byLabel[0] : undefined))?.codexHome
	const argv = request.resume
		? [deps.entry, '--resume', request.resume, ...(byId ? ['--account', byId.id] : [])]
		: request.first
			? [...args]
			: [deps.entry, ...(byId ? ['--account', byId.id] : [])]
	return {
		file: process.execPath,
		args: argv,
		cwd: request.cwd,
		env: buildPtyEnv(deps.env, {
			NAMZU_SPACE_SLOT: request.slot,
			// A session reads this to know its terminal belongs to this host: its own ← then asks the host to leave it.
			NAMZU_SPACE_HOST_PID: String(process.pid),
			...(home ? { CODEX_HOME: home } : {}),
			// A session started on an account runs on that account's provider and model. A
			// provider or model chosen for the host through the environment would contradict it.
			...(byId ? { NAMZU_PROVIDER: null, NAMZU_MODEL: null } : {}),
		}),
	}
}

/** True when a live terminal reports this conversation, or its writer lease is held. */
export async function conversationInUse(
	query: ConversationQuery,
	peers: PeerSource | undefined,
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	try {
		for (const record of peers?.records() ?? []) {
			if (record.conversationId !== query.conversationId) continue
			try {
				process.kill(record.pid, 0)
				return true
			} catch {
				// That terminal is gone.
			}
		}
	} catch {
		// Records unreadable: fall through to the lease.
	}
	try {
		const { openSessionScope } = await import('../integrations/sessions/store.js')
		const { readSessionLease, isLeaseLive, asSessionId } = await import('@namzu/sdk')
		const scope = await openSessionScope(query.cwd, { env, readOnly: true })
		const lease = await readSessionLease(
			scope.paths.sessionDir({ sessionId: asSessionId(query.conversationId) }),
		)
		return isLeaseLive(lease, Date.now())
	} catch {
		return false
	}
}

export async function runSpaces(
	rawArgs: readonly string[],
	prefixSetting: string | undefined,
	deps: SpacesDeps,
	pointer: { readonly mouse?: MouseMode; readonly copyOnSelect?: boolean } = {},
): Promise<number> {
	if (!deps.stdin.isTTY || !deps.stdout.isTTY) {
		deps.stderr.write('namzu spaces needs an interactive terminal.\n')
		return 1
	}
	const args = [deps.entry, ...rawArgs]
	let binding: HostPtyModule
	try {
		binding = await deps.loadPty()
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0]
		deps.stderr.write(
			`Spaces needs a terminal component that is not available here (${reason}). Starting a single session instead. Run "namzu doctor" to see how to get it.\n`,
		)
		return deps.runPlain(process.execPath, args)
	}
	const prefix =
		(prefixSetting !== undefined ? parsePrefix(prefixSetting) : undefined) ?? DEFAULT_PREFIX
	const peers = createPeerSource(deps.env)
	const store =
		deps.store ??
		fileStore(spacesFilePath(deps.env), (message) => deps.stderr.write(`${message}\n`))
	const restored = store.load()
	const accounts = deps.accounts ?? storedAccounts
	const host = new SpacesHost({
		input: deps.stdin,
		output: deps.stdout,
		binding,
		spec: (request) => sessionSpec(request, deps, accounts(), args),
		accounts,
		store,
		...(restored ? { restored } : {}),
		freshFirst: rawArgs.length > 0,
		inUseElsewhere: deps.inUseElsewhere ?? ((query) => conversationInUse(query, peers, deps.env)),
		folder: { cwd: deps.cwd, name: deps.cwd.split(/[\\/]/u).filter(Boolean).pop() ?? 'session' },
		prefix,
		truecolor: advertisesTruecolor(deps.env),
		mouse: resolveMouseMode(deps.env, pointer.mouse),
		...(pointer.copyOnSelect !== undefined ? { copyOnSelect: pointer.copyOnSelect } : {}),
		...(peers ? { peers } : {}),
	})
	const stop = (): void => host.quit()
	process.on('SIGTERM', stop)
	process.on('SIGHUP', stop)
	host.start()
	try {
		return await host.done
	} finally {
		process.off('SIGTERM', stop)
		process.off('SIGHUP', stop)
	}
}

export const spacesCommand: CommandDef = {
	name: 'spaces',
	description: 'Run Namzu sessions side by side in one terminal (preview)',
	passThrough: true,
	help: SPACES_HELP,
	handler: async ({ ctx, rawArgs }) =>
		runSpaces(rawArgs, ctx.config.tui?.spacesPrefix, realDeps(), {
			...(ctx.config.tui?.mouse !== undefined ? { mouse: ctx.config.tui.mouse } : {}),
			...(ctx.config.tui?.copyOnSelect !== undefined
				? { copyOnSelect: ctx.config.tui.copyOnSelect }
				: {}),
		}),
}
