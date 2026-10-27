/**
 * What the transcript says about a tool server, in a person's words.
 *
 * Servers connect in the background, so each one is reported on its own, when
 * it has connected or has failed. The failure text the connection layer keeps
 * is for logs and headless runs (it names a deadline in milliseconds); here a
 * timeout is "did not answer in time".
 */

import type { ConnectedMcpServer, FailedMcpServer } from '../integrations/mcp/servers.js'
import { plural } from './person-terms.js'
import { terminalDisplayText } from './terminal-display.js'

/** The reason a server is unavailable, as one plain sentence. */
export function plainToolServerReason(reason: string): string {
	const flat = terminalDisplayText(reason).replace(/\s+/g, ' ').trim()
	if (isToolServerTimeout(flat)) return 'It did not answer in time.'
	if (flat === '') return 'No reason was given.'
	return /[.!?]$/.test(flat) ? flat : `${flat}.`
}

/** A deadline the connection layer measured in milliseconds, said without the number. */
export const isToolServerTimeout = (reason: string): boolean =>
	/did not answer within \d+\s*ms/i.test(reason)

export interface ToolServerRow {
	readonly level: 'notice' | 'warning'
	readonly text: string
}

/** The row for one server that has settled, or `undefined` while it is still being reached. */
export function toolServerRow(
	name: string,
	status: {
		readonly connected: readonly ConnectedMcpServer[]
		readonly failed: readonly FailedMcpServer[]
	},
): ToolServerRow | undefined {
	const label = terminalDisplayText(name)
	const connected = status.connected.find((server) => server.name === name)
	if (connected) {
		return {
			level: 'notice',
			text: `Tool server ${label} · ${plural(connected.toolCount, 'tool')}`,
		}
	}
	const failed = status.failed.find((server) => server.name === name)
	if (failed) {
		return {
			level: 'warning',
			text: `Tool server ${label} is not available. ${plainToolServerReason(failed.reason)}`,
		}
	}
	return undefined
}
