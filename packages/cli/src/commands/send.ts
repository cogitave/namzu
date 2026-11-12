/** Say something to a running session from another terminal. */

import { MAX_PEER_MESSAGE_TEXT_BYTES, type TenantId } from '@namzu/sdk'
import {
	EXIT_DATAERR,
	EXIT_FAIL,
	EXIT_NOINPUT,
	EXIT_OK,
	EXIT_UNAVAILABLE,
	EXIT_USAGE,
} from '../exit-codes.js'
import {
	type SessionSendReceipt,
	type SessionSendStatus,
	sendToSession,
} from '../integrations/peers/send-person.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { readIdentity } from '../integrations/state/identity.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { CLI_VERSION } from '../version.js'
import { decodePeerInput, readBoundedFile, readBoundedStream } from './peer-input.js'
import type { CommandDef } from './types.js'

/** Accepted into the session's inbox; not taken yet. Distinct from every other outcome. */
export const EXIT_SEND_ACCEPTED = 10

/** How long the command waits to hear the session took the message, unless `--wait` says otherwise. */
export const DEFAULT_SEND_WAIT_SECONDS = 30
const MAX_SEND_WAIT_SECONDS = 3600

const HELP = `namzu send — say something to a running session, from another terminal

Usage:
  namzu send <session> <message...> [--wait <seconds>] [--json]
  namzu send <session> --file <path>|- [--wait <seconds>] [--json]
  echo "stop after this step" | namzu send <session>

session   A whole session id or the start of one, chosen as \`namzu watch\` chooses.
message   The words to say, or --file <path> (- is standard input) to keep line
          breaks. With no words and input piped in, standard input is read.
--wait    Seconds to wait for the session to take the message (default ${DEFAULT_SEND_WAIT_SECONDS}).
          0 answers as soon as the message is accepted.

The message is the person's own words: the model is told it came from you, at
another terminal, not from another agent and not from a tool. It is text for the
model only. It is not an approval, cannot answer a question the session asks,
cannot change the permission mode and is never run as a command: text that starts
with a slash is still just text. The session takes it at its next request
boundary, or, when it is idle, at the start of a turn it begins for it.

Only a terminal of this account on this machine that has the session open reads
messages. A background, scheduled or finished session does not; nothing is opened
to the network and nothing is written to the session's log from here.

Answers:
  Delivered    the session's process took the message into its turn.      Exit 0.
  Accepted     in the session's inbox, not taken yet; it stays queued
               there until it is taken or the terminal closes.            Exit ${EXIT_SEND_ACCEPTED}.
  Refused      the session declined, or does not read messages.           Exit 1.
  Unreachable  nothing runs the session (finished, gone) or nothing
               answered; acceptance is unknown if no receipt arrived.     Exit 69.
  Not found    no such session, or not this account's.                    Exit 66.
Bad arguments or an empty message exit 64, input that is not UTF-8 text 65,
an unreadable file 66. A message over 32 KiB is refused before anything is sent.\n`

export type SendArgs =
	| {
			readonly session: string
			readonly words: readonly string[]
			readonly file?: string
			readonly waitSeconds: number
			readonly json: boolean
	  }
	| { readonly error: string }

/** Parse the words after `namzu send`. Flags may stand anywhere; `--` ends them. */
export function parseSendArgs(rawArgs: readonly string[]): SendArgs {
	let json = false
	let file: string | undefined
	let waitSeconds = DEFAULT_SEND_WAIT_SECONDS
	const operands: string[] = []
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i] as string
		if (arg === '--') {
			operands.push(...rawArgs.slice(i + 1))
			break
		}
		const takeValue = (name: string, inline: string | undefined): string | { error: string } => {
			const value = inline ?? rawArgs[++i]
			if (value === undefined || (inline === undefined && value.startsWith('--') && value !== '--'))
				return { error: `${name} needs a value.` }
			return value
		}
		if (arg === '--json') json = true
		else if (arg === '--file' || arg.startsWith('--file=')) {
			const value = takeValue('--file', arg.startsWith('--file=') ? arg.slice(7) : undefined)
			if (typeof value !== 'string') return value
			file = value
		} else if (arg === '--wait' || arg.startsWith('--wait=')) {
			const value = takeValue('--wait', arg.startsWith('--wait=') ? arg.slice(7) : undefined)
			if (typeof value !== 'string') return value
			if (!/^\d+$/.test(value) || Number(value) > MAX_SEND_WAIT_SECONDS)
				return {
					error: `--wait takes a whole number of seconds from 0 to ${MAX_SEND_WAIT_SECONDS}.`,
				}
			waitSeconds = Number(value)
		} else if (arg.startsWith('--')) return { error: `Unknown option ${arg}.` }
		else operands.push(arg)
	}
	const [session, ...words] = operands
	if (!session) return { error: 'send needs a session: an id or the start of one.' }
	if (file !== undefined && words.length)
		return { error: 'Give the message as words or --file, not both.' }
	return { session, words, ...(file !== undefined ? { file } : {}), waitSeconds, json }
}

export function exitCodeOfSend(status: SessionSendStatus): number {
	switch (status) {
		case 'delivered':
			return EXIT_OK
		case 'accepted':
			return EXIT_SEND_ACCEPTED
		case 'refused':
			return EXIT_FAIL
		case 'unreachable':
			return EXIT_UNAVAILABLE
		case 'not-found':
			return EXIT_NOINPUT
	}
}

const LABELS: Readonly<Record<SessionSendStatus, string>> = {
	delivered: 'Delivered',
	accepted: 'Accepted',
	refused: 'Refused',
	unreachable: 'Unreachable',
	'not-found': 'Not found',
}

export function renderSendReceipt(receipt: SessionSendReceipt): string {
	return `${LABELS[receipt.status]}: ${receipt.reason}`
}

/** What the command needs from its surroundings; the handler fills it from the process. */
export interface SendIO {
	readonly home: string
	readonly tenantId: TenantId
	readonly currentSlug?: string
	readonly cwd: string
	/** Standard input, for a message that is piped in. */
	readonly stdin: AsyncIterable<Uint8Array | string> & { readonly isTTY?: boolean }
	readonly stdout: (text: string) => void
	readonly stderr: (text: string) => void
	/** A promise that settles after `seconds`; the command's wait for "taken". Tests settle their own. */
	readonly timer: (seconds: number) => Promise<void>
	readonly send?: typeof sendToSession
	readonly readFile?: (path: string) => Promise<Uint8Array>
}

/** The whole command, against explicit surroundings. */
export async function runSend(args: SendArgs, io: SendIO): Promise<number> {
	if ('error' in args) {
		io.stderr(`${args.error}\n\n${HELP}`)
		return EXIT_USAGE
	}
	const fail = (message: string, code: number): number => {
		if (args.json) io.stdout(`${JSON.stringify({ error: message, exit: code })}\n`)
		else io.stderr(`${message}\n`)
		return code
	}
	let message = args.words.join(' ')
	const fromInput = args.file !== undefined || args.words.length === 0
	if (fromInput) {
		if (args.file === undefined && io.stdin.isTTY)
			return fail('send needs a message: give words, --file, or pipe text in.', EXIT_USAGE)
		let bytes: Uint8Array
		try {
			bytes =
				args.file === undefined || args.file === '-'
					? await readBoundedStream(io.stdin)
					: await (io.readFile ?? readBoundedFile)(args.file)
		} catch (cause) {
			return fail(
				`Cannot read ${args.file ?? 'standard input'}: ${cause instanceof Error ? cause.message : String(cause)}`,
				EXIT_NOINPUT,
			)
		}
		const input = decodePeerInput(bytes)
		if (input.kind === 'invalid') return fail(input.reason, EXIT_DATAERR)
		if (input.kind === 'too-large')
			return fail(
				`Message is over the ${MAX_PEER_MESSAGE_TEXT_BYTES / 1024} KiB limit. Nothing was sent.`,
				EXIT_FAIL,
			)
		message = input.text
	}
	if (!message.trim()) return fail('send needs a message with some text.', EXIT_USAGE)
	const receipt = await (io.send ?? sendToSession)({
		home: io.home,
		tenantId: io.tenantId,
		...(io.currentSlug ? { currentSlug: io.currentSlug } : {}),
		cwd: io.cwd,
		version: CLI_VERSION,
		session: args.session,
		message,
		...(args.waitSeconds > 0 ? { window: io.timer(args.waitSeconds) } : {}),
	})
	const exit = exitCodeOfSend(receipt.status)
	if (args.json) io.stdout(`${JSON.stringify({ ...receipt, exit })}\n`)
	else io.stdout(`${terminalDisplayText(renderSendReceipt(receipt))}\n`)
	return exit
}

export const sendCommand: CommandDef = {
	name: 'send',
	description: 'Say something to a running session from another terminal',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const parsed = parseSendArgs(rawArgs)
		const wantsJson = 'error' in parsed ? rawArgs.includes('--json') : parsed.json
		const root = resolveNamzuHome()
		const identity = readIdentity(root)
		if (!identity) {
			const message =
				'Namzu has not been used on this machine yet, so there is no session to message.'
			if (wantsJson)
				process.stdout.write(`${JSON.stringify({ error: message, exit: EXIT_NOINPUT })}\n`)
			else ctx.formatter.error({ message })
			return EXIT_NOINPUT
		}
		let currentSlug: string | undefined
		try {
			const { openSessionScope } = await import('../integrations/sessions/store.js')
			currentSlug = (await openSessionScope(process.cwd(), { readOnly: true })).slug
		} catch {
			// This folder has no history; sessions of other folders are still addressable.
		}
		const timers: NodeJS.Timeout[] = []
		try {
			return await runSend(parsed, {
				home: root,
				tenantId: identity.tenantId,
				...(currentSlug ? { currentSlug } : {}),
				cwd: process.cwd(),
				stdin: process.stdin,
				stdout: (text) => void process.stdout.write(text),
				stderr: (text) => void process.stderr.write(text),
				timer: (seconds) =>
					new Promise<void>((resolve) => {
						timers.push(setTimeout(resolve, seconds * 1000))
					}),
			})
		} catch (cause) {
			const message = `Sending is unavailable: ${terminalDisplayText(cause instanceof Error ? cause.message : String(cause))}`
			if (wantsJson)
				process.stdout.write(`${JSON.stringify({ error: message, exit: EXIT_UNAVAILABLE })}\n`)
			else ctx.formatter.error({ message })
			return EXIT_UNAVAILABLE
		} finally {
			for (const timer of timers) clearTimeout(timer)
		}
	},
}
