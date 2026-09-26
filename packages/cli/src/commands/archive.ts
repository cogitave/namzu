/** Inspect and restore conversations archived in the current project. */

import { asSessionId } from '@namzu/sdk'

import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	closeSessions,
	listArchived,
	openSessions,
	unarchiveConversation,
} from '../integrations/sessions/store.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import type { CommandDef } from './types.js'

const HELP = `namzu archive — inspect and restore archived conversations in this folder

Usage:
  namzu archive list [--page <n>]
  namzu archive restore <conversation-id>

Lists up to 100 conversations per page. Restoring makes the conversation
available to namzu resume <conversation-id>.
The history remains in the same project. No files are deleted.\n`

export const archiveCommand: CommandDef = {
	name: 'archive',
	description: 'List or restore archived conversations in this project',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const [verb = 'list', ...operands] = rawArgs
		const pageSpecified =
			operands.length === 2 && operands[0] === '--page' && /^[1-9]\d*$/.test(operands[1] as string)
		const page = verb === 'list' && pageSpecified ? Number(operands[1]) : 1
		if (
			!(
				(verb === 'list' &&
					(operands.length === 0 ||
						(pageSpecified && Number.isSafeInteger(page) && page <= 1_000_000))) ||
				(verb === 'restore' && operands.length === 1)
			)
		) {
			ctx.formatter.error({ message: HELP })
			return EXIT_USAGE
		}
		let sessions: Awaited<ReturnType<typeof openSessions>> | undefined
		try {
			sessions = await openSessions(process.cwd())
			if (verb === 'list') {
				const conversations = await listArchived(sessions, 100, (page - 1) * 100)
				const text =
					conversations.length === 0
						? `No archived conversations on page ${page} in this project.`
						: conversations.map((entry) => `${entry.id}  ${entry.title}`).join('\n')
				ctx.formatter.print({ page, conversations, text: terminalDisplayText(text) })
				return EXIT_OK
			}
			const id = asSessionId(operands[0] as string)
			await unarchiveConversation(sessions, id)
			ctx.formatter.print({
				id,
				text: `Restored ${id}. Open it with namzu resume ${id}.`,
			})
			return EXIT_OK
		} catch (cause) {
			ctx.formatter.error({
				message: terminalDisplayText(cause instanceof Error ? cause.message : String(cause)),
			})
			return EXIT_USAGE
		} finally {
			if (sessions) closeSessions(sessions)
		}
	},
}
