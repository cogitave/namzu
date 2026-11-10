/** Message a live Namzu terminal from a command line, without opening a TUI. */

import { readFileSync } from 'node:fs'
import { EXIT_FAIL, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import {
	type PeerListing,
	type PeerSendReceipt,
	listProjectTerminals,
	sendToTerminal,
} from '../integrations/peers/send-once.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { planLaunchMode } from '../permissions/launch.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { CLI_VERSION } from '../version.js'
import { readStdin } from './stdin.js'
import type { CommandDef } from './types.js'

const HELP = `namzu peers — message a live Namzu terminal in this folder

Usage:
  namzu peers list [--json]
  namzu peers send <ref|id|title> <message...> [--json] [--mode <mode>] [--file <path>|-]

list    Live terminals in this project: ref, title, state and permission mode.
send    Queue a message in one terminal's inbox. Give the text as words, or with
        --file <path> (use - for standard input) to keep line breaks.

The message is attributed to a command line, never to the operator, and carries
no approval. The terminal must be in this folder, run by this account, and be in
the same permission mode as this command. --mode states the mode this command
acts under; without it, the mode a new terminal would start in here. A different
mode is refused.

Receipts:
  Queued       accepted into the live inbox; not proof the model read it. Exit 0.
  Refused      the terminal or this command declined, with the reason. Exit 1.
  Unreachable  no terminal answered; acceptance is unknown, do not retry blindly. Exit 69.
Bad arguments exit 64. A message over 32 KiB is refused before anything is sent.\n`

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
	| { readonly error: string }

/** Parse the words after `namzu peers`. Flags may stand anywhere; `--` ends them. */
export function parsePeersArgs(rawArgs: readonly string[]): PeersArgs {
	const [verb, ...rest] = rawArgs
	if (verb !== 'list' && verb !== 'send') return { error: 'Expected list or send.' }
	let json = false
	let file: string | undefined
	let mode: string | undefined
	const operands: string[] = []
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string
		if (arg === '--') {
			operands.push(...rest.slice(i + 1))
			break
		}
		if (arg === '--json') json = true
		else if (verb === 'send' && (arg === '--mode' || arg === '--file')) {
			const value = rest[++i]
			if (value === undefined || (value.startsWith('--') && value !== '--'))
				return { error: `${arg} needs a value.` }
			if (arg === '--mode') mode = value
			else file = value
		} else if (verb === 'send' && arg.startsWith('--mode=')) mode = arg.slice(7)
		else if (verb === 'send' && arg.startsWith('--file=')) file = arg.slice(7)
		else if (arg.startsWith('--')) return { error: `Unknown option ${arg}.` }
		else operands.push(arg)
	}
	if (verb === 'list')
		return operands.length ? { error: 'list takes no arguments.' } : { verb, json }
	const [target, ...words] = operands
	if (!target) return { error: 'send needs a target: a ref, id or title.' }
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

export function renderReceipt(receipt: PeerSendReceipt): string {
	switch (receipt.status) {
		case 'queued':
			return 'Queued: accepted into the live inbox, not proof the model read it.'
		case 'refused':
			return `Refused: ${receipt.reason}`
		case 'unreachable':
			return `Unreachable: ${receipt.reason}`
	}
}

export function receiptExitCode(receipt: PeerSendReceipt): number {
	return receipt.status === 'queued'
		? EXIT_OK
		: receipt.status === 'refused'
			? EXIT_FAIL
			: EXIT_UNAVAILABLE
}

export function renderListing(peers: readonly PeerListing[]): string {
	if (peers.length === 0) return 'No live terminals in this project.'
	return peers
		.map(
			(peer) =>
				`${peer.ref}  ${peer.title}  ${peer.state}  ${peer.mode}${peer.acceptsMessages ? '' : '  (not accepting messages)'}`,
		)
		.join('\n')
}

export const peersCommand: CommandDef = {
	name: 'peers',
	description: 'List live terminals in this project or send one a message',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const parsed = parsePeersArgs(rawArgs)
		if ('error' in parsed) {
			ctx.formatter.error({ message: `${parsed.error}\n\n${HELP}` })
			return EXIT_USAGE
		}
		const emit = (value: object, text: string) => {
			if (parsed.json) process.stdout.write(`${JSON.stringify(value)}\n`)
			else ctx.formatter.print({ ...value, text: terminalDisplayText(text) })
		}
		const base = {
			home: resolveNamzuHome(),
			cwd: process.cwd(),
			version: CLI_VERSION,
		}
		try {
			if (parsed.verb === 'list') {
				const peers = await listProjectTerminals(base)
				emit({ peers }, renderListing(peers))
				return EXIT_OK
			}
			let mode = parsed.mode
			const plan = planLaunchMode({
				permissionModeFlag: mode,
				settings: ctx.config.permissionSettings,
			})
			if ('error' in plan) {
				ctx.formatter.error({ message: plan.error })
				return EXIT_USAGE
			}
			mode = plan.plan.mode
			let message = parsed.words.join(' ')
			if (parsed.file !== undefined) {
				try {
					message = parsed.file === '-' ? await readStdin() : readFileSync(parsed.file, 'utf8')
				} catch (cause) {
					ctx.formatter.error({
						message: `Cannot read ${parsed.file}: ${cause instanceof Error ? cause.message : String(cause)}`,
					})
					return EXIT_USAGE
				}
				// One trailing line break is the file's, not the message's.
				message = message.replace(/\r?\n$/, '')
			}
			const receipt = await sendToTerminal({ ...base, target: parsed.target, message, mode })
			emit({ ...receipt, mode }, renderReceipt(receipt))
			return receiptExitCode(receipt)
		} catch (cause) {
			ctx.formatter.error({
				message: `Peer messaging is unavailable: ${terminalDisplayText(cause instanceof Error ? cause.message : String(cause))}`,
			})
			return EXIT_UNAVAILABLE
		}
	},
}
