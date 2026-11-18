import {
	type UserMcpServerChange,
	type UserMcpServerResult,
	type UserMcpServersView,
	commandConfirmation,
	readUserMcpServerChange,
	startsNewCommand,
} from '../shared/config-lists-protocol.js'
import { FolderAccessTokens } from './folder-access.js'

export interface UserMcpServersDeps {
	read(): Promise<UserMcpServersView>
	/** Saves the change, or with `dryRun` only says whether the engine would take it. */
	save(change: UserMcpServerChange, dryRun: boolean): Promise<UserMcpServersView>
	remove(name: string): Promise<UserMcpServersView>
	tokens?: FolderAccessTokens
}

/**
 * Adds, edits and removes the tool servers in the person's own config file. A server that runs a
 * command is not saved on the window's word alone: main answers `confirm` with a one-time token
 * bound to that window and that exact change, and saves only when the same change returns with it.
 * The engine checks every change and does the writing; this class never touches a file.
 */
export class UserMcpServers {
	private readonly tokens: FolderAccessTokens
	constructor(private readonly deps: UserMcpServersDeps) {
		this.tokens = deps.tokens ?? new FolderAccessTokens()
	}

	read(): Promise<UserMcpServersView> {
		return this.deps.read()
	}

	async save(windowId: string, raw: unknown, token?: unknown): Promise<UserMcpServerResult> {
		const change = readUserMcpServerChange(raw)
		if (token !== undefined && typeof token !== 'string') throw new Error('Invalid confirmation.')
		const view = await this.deps.read()
		const held = view.servers.find((server) => server.name === change.name)
		if (startsNewCommand(change, held)) {
			const key = JSON.stringify(change)
			if (token === undefined) {
				// A change the engine would refuse never costs a question.
				await this.deps.save(change, true)
				return {
					status: 'confirm',
					view,
					token: this.tokens.issue(windowId, key),
					message: commandConfirmation(change),
				}
			}
			if (!this.tokens.redeem(token, windowId, key)) throw new Error('The confirmation expired.')
		}
		return { status: 'saved', view: await this.deps.save(change, false) }
	}

	async remove(name: unknown): Promise<UserMcpServersView> {
		if (typeof name !== 'string' || name.length === 0 || name.length > 64)
			throw new Error('Choose the tool server to remove.')
		return this.deps.remove(name)
	}
}
