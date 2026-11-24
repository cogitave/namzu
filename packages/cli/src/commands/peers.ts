/** Message a live Namzu terminal, and see and manage your Namzu network, from a command line. */

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
	MAX_PEER_MESSAGE_TEXT_BYTES,
	type RosterView,
	derivePeerRef,
	generateSessionId,
	hardenPeerRuntimeDir,
	parseHostPort,
} from '@namzu/sdk'
import { planSettingChange } from '../config/setting-cli.js'
import {
	EXIT_DATAERR,
	EXIT_FAIL,
	EXIT_HELD,
	EXIT_NOINPUT,
	EXIT_OK,
	EXIT_UNAVAILABLE,
	EXIT_USAGE,
} from '../exit-codes.js'
import { secretForHome } from '../integrations/network/computer-secret.js'
import {
	ControlError,
	createControlClient,
	readControlInfo,
} from '../integrations/network/control.js'
import {
	modeWord,
	renderRosterList,
	renderStatus,
	rosterJson,
} from '../integrations/network/format.js'
import { processExists, readLock } from '../integrations/network/leader.js'
import { decideNetwork, networkSettings } from '../integrations/network/policy.js'
import { formatSessionList } from '../integrations/network/session-list.js'
import type { NetworkControl, NetworkSummary } from '../integrations/network/types.js'
import {
	type PeerListing,
	type PeerSendReceipt,
	listLocalTerminals,
	localStartTimes,
	sendToTerminal,
} from '../integrations/peers/send-once.js'
import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { planLaunchMode } from '../permissions/launch.js'
import type { PermissionSettings } from '../permissions/settings.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { CLI_VERSION } from '../version.js'
import { PEERS_ACTIONS } from './actions/peers.js'
import { decodePeerInput, readBoundedFile, readBoundedStream } from './peer-input.js'
import type { CommandDef } from './types.js'

const HELP = `namzu peers — your Namzu sessions, on this machine and on your other machines

Usage:
  namzu peers list [--json]
  namzu peers send <ref|id|title|machine/name> <message...> [--json] [--mode <mode>] [--file <path>|-]
  namzu peers status [--json]
  namzu peers on [--anyway] | off
  namzu peers allow <code|name> [--trust [--as <name>]] | deny <code|name>
  namzu peers networks [rename <name> <new name>] [--json]
  namzu peers untrust <name>
  namzu peers same computer reset
  namzu peers remove <machine> [--and-its-admissions]
  namzu peers rename <new name...>
  namzu peers role <session|machine/> <text...> | --clear
  namzu peers add <host[:port]>
  namzu peers join [<host[:port]>]
  namzu peers cancel
  namzu peers log [-n <count>] [--json]

list    Every live Namzu session here, one counted list: "[state]  ·  name  ·  started 7m ago",
        with the folder, permission mode and role on a second line. When your Namzu network is
        running, every machine's sessions are in the same list, with the machine name last.
send    Queue a message in one terminal's inbox. Give the text as words, or with
        --file <path> (use - for standard input) to keep line breaks. A session on
        another machine is named by its name, or machine/name.
status  Whether your Namzu network is on, how many machines are in it, and what waits for you.
on/off  Turn your Namzu network on (automatic on a private network; --anyway on any
        network) or off for good. Open terminals pick it up when they next start.
allow/deny  Decide a request from a new machine to join your network. Any machine can allow.
networks    The networks you trust: a new machine on one joins without asking. \`allow --trust\`
        trusts the network the request came from (--as names it; the default is Network 1, 2, ...).
        A network counts only when its gateway can be read; otherwise it is unknown and never trusted.
        The setting network.autoAdmit changes this: trusted-networks (default), always, never.
untrust     Stop trusting a network, so its new machines ask for an Allow again.
same computer reset  Your Namzu homes on this computer (terminal, Desktop, WSL, scheduled services) join
        without asking because they share a secret of yours. This deletes that secret: the next one made
        is new for all of them, and until they all read it new homes ask again. The setting
        network.sameComputer: false turns the automatic join off.
remove  Take a machine out of your network. --and-its-admissions also removes the machines it let in.
rename  Rename this machine; the others show the new name.
role    Describe what a session (or a machine, written machine/) is for. The role is shown in
        the list and told to that session as context. It grants no permission and
        changes no permission mode. --clear removes it.
add     Add a machine by address, for a network where multicast does not reach (WSL2 for one).
join    Ask the Namzu network nearby to let this machine in.
cancel  Withdraw the request this machine is waiting on.
log     The audit log of the network: joins, removals, roles and every message decision. No message text.

The network needs a Namzu terminal open on this machine: that terminal runs it, and these
commands ask it. A message is attributed to a command line, never to the operator, and carries
no approval. The terminal must be run by this account and be in the same permission mode as
this command. --mode states the mode this command acts under; without it, the mode a new
terminal would start in here (permissions.defaultMode, else auto unless
permissions.disableAutoMode is set). A different mode, or a terminal in bypass, does not refuse
the message: the receiving terminal holds it for its person to allow or deny.

Receipts:
  Queued       accepted into the live inbox; not proof the model read it. Exit 0.
  Refused      the terminal or this command declined, with the reason. Exit 1.
  Held         the receiving terminal keeps it for its person to allow or deny. Exit 4.
  Unreachable  no terminal answered; acceptance is unknown, do not retry blindly. Exit 69.
Bad arguments or an empty message exit 64, input that is not UTF-8 text 65, an
unreadable file 66. A command that needs the network and finds no terminal running it exits 69.
A message over 32 KiB is refused before anything is sent.\n`

export type PeersArgs =
	| { readonly verb: 'list'; readonly json: boolean }
	| {
			readonly verb: 'send'
			readonly json: boolean
			readonly target: string
			readonly words: readonly string[]
			readonly file?: string
			readonly mode?: string
	  }
	| { readonly verb: 'status'; readonly json: boolean }
	| { readonly verb: 'on'; readonly json: boolean; readonly anyway: boolean }
	| { readonly verb: 'off'; readonly json: boolean }
	| {
			readonly verb: 'allow'
			readonly json: boolean
			readonly query: string
			readonly trust?: boolean | string
	  }
	| { readonly verb: 'deny'; readonly json: boolean; readonly query: string }
	| {
			readonly verb: 'networks'
			readonly json: boolean
			readonly rename?: readonly [string, string]
	  }
	| { readonly verb: 'untrust'; readonly json: boolean; readonly name: string }
	| { readonly verb: 'same'; readonly json: boolean }
	| {
			readonly verb: 'remove'
			readonly json: boolean
			readonly machine: string
			readonly cascade: boolean
	  }
	| { readonly verb: 'rename'; readonly json: boolean; readonly name: string }
	| {
			readonly verb: 'role'
			readonly json: boolean
			readonly target: string
			readonly role: string | null
	  }
	| { readonly verb: 'add'; readonly json: boolean; readonly hostPort: string }
	| { readonly verb: 'join'; readonly json: boolean; readonly hostPort?: string }
	| { readonly verb: 'cancel'; readonly json: boolean }
	| { readonly verb: 'log'; readonly json: boolean; readonly count: number }
	| { readonly error: string }

const VERBS = [
	'list',
	'send',
	'status',
	'on',
	'off',
	'allow',
	'deny',
	'networks',
	'untrust',
	'same',
	'remove',
	'rename',
	'role',
	'add',
	'join',
	'cancel',
	'log',
] as const
const DEFAULT_LOG_LINES = 50

/** Parse the words after `namzu peers`. Flags may stand anywhere; `--` ends them. */
export function parsePeersArgs(rawArgs: readonly string[]): PeersArgs {
	const [first, ...rest] = rawArgs
	// A bare `namzu peers` is `namzu peers list`.
	const verb = first === undefined ? 'list' : first
	if (!(VERBS as readonly string[]).includes(verb))
		return { error: `Expected one of: ${VERBS.join(', ')}.` }
	const args = first === undefined ? rest : rest
	let json = false
	let file: string | undefined
	let mode: string | undefined
	let anyway = false
	let cascade = false
	let clear = false
	let trust = false
	let trustName: string | undefined
	let count: number | undefined
	const operands: string[] = []
	const takes = (flag: string) =>
		(verb === 'send' && (flag === '--mode' || flag === '--file')) ||
		(verb === 'allow' && flag === '--as') ||
		(verb === 'log' && (flag === '-n' || flag === '--lines'))
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		if (arg === '--') {
			operands.push(...args.slice(i + 1))
			break
		}
		if (arg === '--json') json = true
		else if (verb === 'on' && arg === '--anyway') anyway = true
		else if (verb === 'remove' && arg === '--and-its-admissions') cascade = true
		else if (verb === 'role' && arg === '--clear') clear = true
		else if (verb === 'allow' && arg === '--trust') trust = true
		else if (takes(arg)) {
			const value = args[++i]
			if (value === undefined || (value.startsWith('--') && value !== '--'))
				return { error: `${arg} needs a value.` }
			if (arg === '--mode') mode = value
			else if (arg === '--file') file = value
			else if (arg === '--as') trustName = value
			else {
				const n = Number(value)
				if (!Number.isInteger(n) || n < 1 || n > 1000)
					return { error: `${arg} needs a whole number from 1 to 1000.` }
				count = n
			}
		} else if (verb === 'send' && arg.startsWith('--mode=')) mode = arg.slice(7)
		else if (verb === 'send' && arg.startsWith('--file=')) file = arg.slice(7)
		else if (
			arg.startsWith('--') ||
			(arg.startsWith('-') && arg.length > 1 && /^-[a-z]/i.test(arg))
		)
			return { error: `Unknown option ${arg}.` }
		else operands.push(arg)
	}
	switch (verb) {
		case 'list':
		case 'status':
		case 'off':
			return operands.length
				? { error: `${verb} takes no arguments.` }
				: verb === 'off'
					? { verb, json }
					: { verb, json }
		case 'on':
			return operands.length ? { error: 'on takes no arguments.' } : { verb, json, anyway }
		case 'send': {
			const [target, ...words] = operands
			if (!target) return { error: 'send needs a target: a ref, id, title or machine/name.' }
			if (file !== undefined && words.length)
				return { error: 'Give the message as words or --file, not both.' }
			if (file === undefined && words.length === 0) return { error: 'send needs a message.' }
			if (mode === '') return { error: '--mode needs a value.' }
			return {
				verb,
				json,
				target,
				words,
				...(file !== undefined ? { file } : {}),
				...(mode ? { mode } : {}),
			}
		}
		case 'allow':
		case 'deny': {
			if (operands.length === 0)
				return { error: `${verb} needs the code or the name of the request.` }
			const query = operands.every((word) => /^\d+$/.test(word))
				? operands.join('')
				: operands.join(' ')
			if (verb === 'deny') return { verb, json, query }
			if (trustName !== undefined && !trust) return { error: '--as goes with --trust.' }
			return {
				verb,
				json,
				query,
				...(trust ? { trust: trustName ?? true } : {}),
			}
		}
		case 'networks': {
			if (operands.length === 0) return { verb, json }
			if (operands[0] === 'rename' && operands.length === 3)
				return { verb, json, rename: [operands[1] as string, operands[2] as string] }
			return { error: 'networks takes no arguments, or: rename <name> <new name>.' }
		}
		case 'untrust': {
			if (operands.length === 0) return { error: 'untrust needs the name of a network.' }
			return { verb, json, name: operands.join(' ') }
		}
		case 'same':
			return operands.join(' ') === 'computer reset'
				? { verb, json }
				: { error: 'same is used as: same computer reset.' }
		case 'remove': {
			if (operands.length === 0) return { error: 'remove needs the name of a machine.' }
			return { verb, json, machine: operands.join(' '), cascade }
		}
		case 'rename': {
			if (operands.length === 0) return { error: 'rename needs the new name.' }
			return { verb, json, name: operands.join(' ') }
		}
		case 'role': {
			const [target, ...words] = operands
			if (!target) return { error: 'role needs a session, or a machine written machine/.' }
			if (clear && words.length) return { error: 'Give a role or --clear, not both.' }
			if (!clear && words.length === 0) return { error: 'role needs the role text, or --clear.' }
			return { verb, json, target, role: clear ? null : words.join(' ') }
		}
		case 'add': {
			const [hostPort, ...extra] = operands
			if (!hostPort || extra.length) return { error: 'add needs one address: host or host:port.' }
			try {
				parseHostPort(hostPort)
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
			return { verb, json, hostPort }
		}
		case 'join': {
			if (operands.length > 1) return { error: 'join takes at most one address.' }
			const [hostPort] = operands
			if (hostPort !== undefined) {
				try {
					parseHostPort(hostPort)
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) }
				}
			}
			return { verb, json, ...(hostPort !== undefined ? { hostPort } : {}) }
		}
		case 'cancel':
			return operands.length ? { error: 'cancel takes no arguments.' } : { verb, json }
		case 'log':
			return operands.length
				? { error: 'log takes no arguments.' }
				: { verb, json, count: count ?? DEFAULT_LOG_LINES }
	}
	return { error: 'Unknown command.' }
}

export function renderReceipt(receipt: PeerSendReceipt): string {
	switch (receipt.status) {
		case 'queued':
			return 'Queued: accepted into the live inbox, not proof the model read it.'
		case 'held':
			return `Held: ${receipt.reason}`
		case 'refused':
			return `Refused: ${receipt.reason}`
		case 'unreachable':
			return `Unreachable: ${receipt.reason}`
	}
}

export function receiptExitCode(receipt: PeerSendReceipt): number {
	return receipt.status === 'queued'
		? EXIT_OK
		: receipt.status === 'held'
			? EXIT_HELD
			: receipt.status === 'refused'
				? EXIT_FAIL
				: EXIT_UNAVAILABLE
}

export function renderListing(
	peers: readonly PeerListing[],
	options: { readonly now?: number; readonly columns?: number } = {},
): string {
	return formatSessionList(
		peers.map((peer) => ({
			ref: peer.ref,
			name: peer.title,
			named: peer.named,
			folder: peer.path,
			state: peer.state,
			startedAt: peer.startedAt,
			mode: modeWord(peer.mode),
			...(peer.role ? { role: peer.role } : {}),
			acceptsMessages: peer.acceptsMessages,
		})),
		{
			now: options.now ?? Date.now(),
			columns: options.columns,
		},
	)
}

/**
 * The mode a send acts under: the one `--mode` names, else the one a new
 * terminal in this folder plans to start in, auto by default included, so a
 * plain send reaches a terminal that started in its own default.
 */
export function peerSenderMode(
	mode: string | undefined,
	settings: PermissionSettings | undefined,
): ReturnType<typeof planLaunchMode> {
	return planLaunchMode({ permissionModeFlag: mode, settings, interactive: true })
}

/** One line of the network audit log, in words. Never text of a message: the log holds none. */
export function renderAuditLine(line: string): string | undefined {
	try {
		const entry = JSON.parse(line) as {
			at?: number
			event?: string
			machine?: { name?: string; id12?: string }
			session?: string
			decision?: string
			direction?: string
			reason?: string
		}
		if (typeof entry.at !== 'number' || typeof entry.event !== 'string') return undefined
		const when = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19)
		const who = entry.machine?.name ?? entry.machine?.id12 ?? ''
		const way = entry.direction === 'out' ? 'to' : entry.direction === 'in' ? 'from' : ''
		return [
			when,
			entry.event,
			way && who ? `${way} ${who}` : who,
			entry.session ?? '',
			entry.decision ?? '',
			entry.reason ?? '',
		]
			.filter((part, index) => index < 2 || part !== '')
			.join('  ')
	} catch {
		return undefined
	}
}

/** The last `count` readable lines of the audit log (the rotated one is not read). */
export function readAuditTail(home: string, count: number): string[] {
	let text: string
	try {
		text = readFileSync(join(home, 'network', 'audit.jsonl'), 'utf8')
	} catch {
		return []
	}
	return text.split('\n').filter(Boolean).slice(-count)
}

export interface PeersIo {
	readonly json: boolean
	/** The width of the terminal when output is one; undefined when piped, so no word is cut. */
	readonly columns?: number
	print(value: object, text: string): void
	fail(message: string, code: number, withHelp?: boolean): number
}

export interface PeersDeps {
	readonly home: string
	readonly cwd: string
	readonly version: string
	/** The network on this machine through the terminal that runs it. */
	readonly control: NetworkControl
	/** Whether a terminal that runs the network is up. */
	readonly leaderUp: () => boolean
	readonly config: Parameters<typeof networkSettings>[0]
	readonly env: NodeJS.ProcessEnv
	readonly writeSetting: (
		key: string,
		text: string,
	) =>
		| { readonly ok: true; readonly message: string }
		| { readonly ok: false; readonly error: string }
	readonly permissionSettings: PermissionSettings | undefined
	readonly now: () => number
	/** `os.networkInterfaces`; tests supply their own. */
	readonly interfaces?: () => ReturnType<typeof networkInterfaces>
	/** Delete the computer secret this home uses. Resolves false when this home uses none. */
	readonly resetComputerSecret?: () => Promise<boolean>
}

const NO_TERMINAL = 'No Namzu terminal is running here; the network needs one open.'

/** What a failed network call says and which exit it earns. */
function networkFailure(io: PeersIo, error: unknown): number {
	const message = terminalDisplayText(error instanceof Error ? error.message : String(error))
	if (error instanceof ControlError && (error.code === 'no-leader' || error.code === 'unreachable'))
		return io.fail(error.code === 'no-leader' ? NO_TERMINAL : message, EXIT_UNAVAILABLE)
	return io.fail(message, EXIT_FAIL)
}

export async function executePeers(
	parsed: Exclude<PeersArgs, { error: string }>,
	deps: PeersDeps,
	io: PeersIo,
): Promise<number> {
	// The environment the command was given, so the runtime folder it reads is that one, not this process's.
	const base = { home: deps.home, cwd: deps.cwd, version: deps.version, env: deps.env }
	const settings = networkSettings(deps.config)
	switch (parsed.verb) {
		case 'list': {
			const peers = await listLocalTerminals(base).catch(() => [] as PeerListing[])
			let view: RosterView | undefined
			if (deps.leaderUp()) {
				try {
					view = await deps.control.roster()
				} catch {
					view = undefined
				}
			}
			if (view && view.machines.length > 0) {
				const startTimes = localStartTimes(base)
				io.print(
					{ peers, machines: rosterJson(view, startTimes) },
					renderRosterList(view, { columns: io.columns, startTimes, now: deps.now() }),
				)
				return EXIT_OK
			}
			// No machines to show: say why when the network is running but this machine is out of it
			// (removed, still looking, more than one nearby), so an empty list is never a puzzle.
			let network: NetworkSummary | undefined
			if (deps.leaderUp()) {
				try {
					network = await deps.control.summary()
				} catch {
					network = undefined
				}
			}
			const why =
				network && network.state !== 'ready' ? `\n${renderStatus(network, deps.now())}` : ''
			io.print(
				{
					peers,
					...(network
						? { network: { state: network.state, removed: network.removed === true } }
						: {}),
				},
				`${renderListing(peers, { now: deps.now(), columns: io.columns })}${why}`,
			)
			return EXIT_OK
		}
		case 'status': {
			if (!deps.leaderUp()) {
				const decision = decideNetwork({
					settings,
					env: deps.env,
					interactive: true,
					interfaces: deps.interfaces ?? networkInterfaces,
				})
				const text = decision.run ? NO_TERMINAL : decision.text
				io.print({ running: false, reason: text }, text)
				return EXIT_OK
			}
			try {
				const summary = await deps.control.summary()
				io.print({ running: true, ...summary }, renderStatus(summary, deps.now()))
				return EXIT_OK
			} catch (error) {
				return networkFailure(io, error)
			}
		}
		case 'on':
		case 'off': {
			const text =
				parsed.verb === 'off' ? 'false' : (parsed as { anyway: boolean }).anyway ? 'true' : 'auto'
			const result = deps.writeSetting('network.enabled', text)
			if (!result.ok) return io.fail(result.error, EXIT_FAIL)
			io.print(
				{ network: parsed.verb === 'off' ? 'off' : text === 'true' ? 'on-anywhere' : 'auto' },
				`${result.message}\nTerminals that are already open pick this up when they next start.`,
			)
			return EXIT_OK
		}
		case 'rename': {
			const saved = deps.writeSetting('network.machineName', parsed.name)
			if (!saved.ok) return io.fail(saved.error, EXIT_FAIL)
			let live = false
			if (deps.leaderUp()) {
				try {
					await deps.control.rename(parsed.name)
					live = true
				} catch (error) {
					return networkFailure(io, error)
				}
			}
			io.print(
				{ renamed: parsed.name, live },
				live
					? `This machine is now called ${parsed.name}.`
					: `This machine will be called ${parsed.name} the next time a Namzu terminal starts the network.`,
			)
			return EXIT_OK
		}
		case 'log': {
			const lines = readAuditTail(deps.home, parsed.count)
			if (io.json) {
				io.print(
					{
						entries: lines.flatMap((line) => {
							try {
								return [JSON.parse(line) as object]
							} catch {
								return []
							}
						}),
					},
					'',
				)
				return EXIT_OK
			}
			const text = lines.map(renderAuditLine).filter((line): line is string => line !== undefined)
			io.print({}, text.length ? text.join('\n') : 'The network audit log is empty.')
			return EXIT_OK
		}
		case 'send': {
			const plan = peerSenderMode(parsed.mode, deps.permissionSettings)
			if ('error' in plan) return io.fail(plan.error, EXIT_USAGE)
			const mode = plan.plan.mode
			let message = parsed.words.join(' ')
			if (parsed.file !== undefined) {
				let bytes: Uint8Array
				try {
					bytes =
						parsed.file === '-'
							? await readBoundedStream(process.stdin)
							: await readBoundedFile(parsed.file)
				} catch (cause) {
					return io.fail(
						`Cannot read ${parsed.file}: ${cause instanceof Error ? cause.message : String(cause)}`,
						EXIT_NOINPUT,
					)
				}
				const input = decodePeerInput(bytes)
				if (input.kind === 'invalid') return io.fail(input.reason, EXIT_DATAERR)
				if (input.kind === 'too-large') {
					const receipt: PeerSendReceipt = {
						status: 'refused',
						reason: `Message is over the ${MAX_PEER_MESSAGE_TEXT_BYTES / 1024} KiB limit. Nothing was sent.`,
					}
					io.print({ ...receipt, mode }, renderReceipt(receipt))
					return receiptExitCode(receipt)
				}
				message = input.text
			}
			if (!message.trim()) return io.fail('send needs a message with some text.', EXIT_USAGE)
			const reachRemote = async (): Promise<PeerSendReceipt | undefined> => {
				if (!deps.leaderUp()) return undefined
				const ref = derivePeerRef(generateSessionId())
				const remote = await deps.control
					.send(parsed.target, message, { sessionRef: ref, sessionName: 'command line', mode })
					.catch((error: unknown) => ({
						status: 'refused' as const,
						reason: error instanceof Error ? error.message : String(error),
					}))
				return remote
					? {
							status: remote.status,
							reason:
								remote.reason ??
								(remote.status === 'queued'
									? 'Accepted in the other machine’s inbox.'
									: 'Held for the person at the receiving terminal.'),
						}
					: undefined
			}
			let receipt: PeerSendReceipt | undefined
			if (parsed.target.includes('/')) receipt = await reachRemote()
			else {
				const local = await sendToTerminal({ ...base, target: parsed.target, message, mode })
				const noMatch =
					local.status === 'refused' && local.reason.startsWith('No matching terminal')
				receipt = noMatch ? ((await reachRemote()) ?? local) : local
			}
			receipt ??= {
				status: 'refused',
				reason: deps.leaderUp()
					? `No session called "${parsed.target}" on your machines. \`namzu peers list\` shows the names.`
					: 'No matching terminal on this computer. Run namzu peers list.',
			}
			io.print({ ...receipt, mode }, renderReceipt(receipt))
			return receiptExitCode(receipt)
		}
		default:
			break
	}
	// Everything below asks the terminal that runs the network.
	if (!deps.leaderUp()) return io.fail(NO_TERMINAL, EXIT_UNAVAILABLE)
	try {
		switch (parsed.verb) {
			case 'allow': {
				const request = parsed.trust
					? await deps.control.allow(parsed.query, { trust: parsed.trust })
					: await deps.control.allow(parsed.query)
				const named = typeof parsed.trust === 'string' ? parsed.trust.toLowerCase() : undefined
				const trusted = parsed.trust
					? [...(await deps.control.networks())]
							.filter((n) => named === undefined || n.name.toLowerCase() === named)
							.sort((x, y) => y.trustedAt - x.trustedAt)[0]
					: undefined
				io.print(
					{ allowed: request.name, ...(trusted ? { trusted: trusted.name } : {}) },
					`Allowed ${request.name} to join your Namzu network.${trusted ? ` This network is trusted as "${trusted.name}": new machines on it join without asking. \`namzu peers untrust ${trusted.name}\` removes that.` : ''}`,
				)
				return EXIT_OK
			}
			case 'networks': {
				if (parsed.rename) {
					const [from, to] = parsed.rename
					const renamed = await deps.control.renameNetwork(from, to)
					io.print({ renamed: renamed.name }, `Renamed the trusted network to "${renamed.name}".`)
					return EXIT_OK
				}
				const networks = await deps.control.networks()
				io.print(
					{ networks },
					networks.length === 0
						? 'No network is trusted. `namzu peers allow <code> --trust` trusts the network a request came from.'
						: networks
								.map((n) => `${n.name}  (${n.id})  new machines on it join without asking`)
								.join('\n'),
				)
				return EXIT_OK
			}
			case 'same': {
				const reset = deps.resetComputerSecret ?? (() => resetHomeSecret(deps.home, deps.env))
				const done = await reset()
				io.print(
					{ reset: done },
					done
						? 'The secret your Namzu homes on this computer share is deleted. The next one made is new; new homes ask for an Allow until each has read it. Machines already in your network stay in it.'
						: 'This home uses no shared secret: nothing to reset.',
				)
				return EXIT_OK
			}
			case 'untrust': {
				const gone = await deps.control.untrust(parsed.name)
				io.print(
					{ untrusted: gone.name },
					`Stopped trusting ${gone.name}. New machines on it ask for an Allow again.`,
				)
				return EXIT_OK
			}
			case 'deny': {
				const request = await deps.control.deny(parsed.query)
				io.print({ denied: request.name }, `Denied ${request.name}.`)
				return EXIT_OK
			}
			case 'remove': {
				const result = await deps.control.remove(parsed.machine, { cascade: parsed.cascade })
				const also =
					result.admitted.length > 0
						? parsed.cascade
							? ` Also removed: ${result.removed.filter((name) => name !== parsed.machine).join(', ') || 'nobody else'}.`
							: ` It had let in ${result.admitted.join(', ')}; they stay unless you remove them too (--and-its-admissions).`
						: ''
				io.print(
					{ removed: result.removed, admitted: result.admitted },
					`Removed ${result.removed.length ? result.removed.join(', ') : parsed.machine} from your Namzu network.${also}`,
				)
				return EXIT_OK
			}
			case 'role': {
				const result = await deps.control.setRole(parsed.target, parsed.role)
				if (result.status !== 'applied')
					return io.fail(result.reason ?? 'The role was refused.', EXIT_FAIL)
				io.print(
					{ target: parsed.target, role: parsed.role },
					parsed.role === null
						? `Cleared the role of ${parsed.target}.`
						: `Set the role of ${parsed.target}. It is told to that session as context and grants nothing.`,
				)
				return EXIT_OK
			}
			case 'add': {
				const result = await deps.control.add(parsed.hostPort)
				io.print(
					{ result },
					result === 'join-requested'
						? `Asked ${parsed.hostPort} to let this machine join. Allow it on one of your other machines.`
						: `Added ${parsed.hostPort}.`,
				)
				return EXIT_OK
			}
			case 'join': {
				if (parsed.hostPort) {
					await deps.control.join(parsed.hostPort)
					io.print(
						{ requested: parsed.hostPort },
						`Asked ${parsed.hostPort} to let this machine join. Allow it on one of your other machines.`,
					)
					return EXIT_OK
				}
				const { networks } = await deps.control.join()
				io.print(
					{ nearby: networks.length },
					networks.length === 0
						? 'No Namzu network found nearby. If your other machines are on a network that does not carry multicast, use `namzu peers add <host[:port]>`.'
						: `Found ${networks.length} Namzu network${networks.length === 1 ? '' : 's'} nearby. Choose one with \`namzu peers join <address>\`:\n${networks.map((n) => `  ${n}`).join('\n')}`,
				)
				return EXIT_OK
			}
			case 'cancel': {
				const cancelled = await deps.control.cancelJoin()
				io.print(
					{ cancelled },
					cancelled ? 'Withdrew the request to join.' : 'No request to join is waiting.',
				)
				return EXIT_OK
			}
			default:
				return io.fail('Unknown command.', EXIT_USAGE)
		}
	} catch (error) {
		return networkFailure(io, error)
	}
}

export const peersCommand: CommandDef = {
	name: 'peers',
	description: 'List and message live terminals, and manage your Namzu network of machines',
	passThrough: true,
	help: HELP,
	actions: PEERS_ACTIONS,
	handler: async ({ ctx, rawArgs }) => {
		const parsed = parsePeersArgs(rawArgs)
		// With --json every outcome, errors included, is one JSON object on stdout.
		const wantsJson = 'error' in parsed ? rawArgs.includes('--json') : parsed.json
		const fail = (message: string, code: number, withHelp = false): number => {
			if (wantsJson) process.stdout.write(`${JSON.stringify({ error: message, exit: code })}\n`)
			else ctx.formatter.error({ message: withHelp ? `${message}\n\n${HELP}` : message })
			return code
		}
		if ('error' in parsed) return fail(parsed.error, EXIT_USAGE, true)
		const io: PeersIo = {
			json: parsed.json,
			columns: process.stdout.isTTY ? process.stdout.columns : undefined,
			print: (value, text) => {
				if (parsed.json) process.stdout.write(`${JSON.stringify(value)}\n`)
				else ctx.formatter.print({ ...value, text: terminalDisplayText(text) })
			},
			fail,
		}
		const home = resolveNamzuHome()
		const networkDir = join(home, 'network')
		const leaderUp = () => {
			const lock = readLock(networkDir)
			return (
				lock !== undefined && processExists(lock.pid) && readControlInfo(networkDir) !== undefined
			)
		}
		try {
			return await executePeers(
				parsed,
				{
					home,
					cwd: process.cwd(),
					version: CLI_VERSION,
					control: createControlClient(() =>
						leaderUp() ? readControlInfo(networkDir) : undefined,
					),
					leaderUp,
					config: ctx.config.network,
					env: process.env,
					writeSetting: (key, text) => {
						const plan = planSettingChange(key, text)
						if (!plan.ok) return { ok: false, error: plan.error }
						try {
							return { ok: true, message: plan.apply() }
						} catch (error) {
							return { ok: false, error: error instanceof Error ? error.message : String(error) }
						}
					},
					permissionSettings: ctx.config.permissionSettings,
					now: () => Date.now(),
				},
				io,
			)
		} catch (cause) {
			return fail(
				`Peer messaging is unavailable: ${terminalDisplayText(cause instanceof Error ? cause.message : String(cause))}`,
				EXIT_UNAVAILABLE,
			)
		}
	},
}

async function resetHomeSecret(home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
	const { source } = await secretForHome(home, env, (dir) => {
		hardenPeerRuntimeDir(dir, process.getuid?.())
		restrictToOwner(dir)
	})
	if (!source) return false
	await rm(source.path, { force: true })
	return true
}
