/**
 * Opening the workspaces screen from the running conversation.
 *
 * Imported on the first `←` only (through a dynamic import in `index.tsx`), so a
 * plain `namzu` pays nothing for it at startup: the host, the terminal emulator
 * and the pseudo-terminal binding all load here.
 */

import type { HostInput, HostOutput, WorkspacesHost } from '../../workspaces/host.js'
import { LocalSession } from './local.js'
import type { TerminalProxy } from './proxy.js'

export interface WorkspacesEntryDeps {
	readonly proxy: TerminalProxy
	/** The real terminal. */
	readonly realOut: NodeJS.WriteStream
	readonly env: NodeJS.ProcessEnv
	readonly cwd: string
	/** The program that starts a session (the CLI's own entry file). */
	readonly entry: string
	readonly prefixSetting: string | undefined
	/** The `tui.mouse` and `tui.copyOnSelect` settings. */
	readonly mouseSetting?: 'full' | 'scroll' | 'off'
	readonly copyOnSelect?: boolean
	/** Ends the conversation the way `/exit` does. */
	readonly requestExit: () => void
	/** Has the App clear the screen and print its whole transcript again. */
	readonly repaint: () => void
}

export interface WorkspacesEntry {
	/** Shows the workspaces screen, or moves the keyboard to its sidebar when it is already up. False when it cannot be shown here. */
	open(): Promise<boolean>
	/** The conversation wants to end: false when it was asked to stay because other sessions are mid-turn. */
	confirmExit(): Promise<boolean>
	/** The conversation is about to unmount: leaves the workspaces screen and has the history printed on the main screen. True when it did. */
	release(stillWanted?: () => boolean): Promise<boolean>
	/** The conversation ended: hangs up the other sessions and gives the terminal back. */
	shutdown(): Promise<void>
}

export function createWorkspacesEntry(deps: WorkspacesEntryDeps): WorkspacesEntry {
	let built: Promise<{
		host: WorkspacesHost
		local: LocalSession
	} | null> | null = null

	const build = async (): Promise<{
		host: WorkspacesHost
		local: LocalSession
	} | null> => {
		const [{ WorkspacesHost: Host }, workspaces, store, peersModule, prefixModule, pty, mouse] =
			await Promise.all([
				import('../../workspaces/host.js'),
				import('../../commands/workspaces.js'),
				import('../../workspaces/store.js'),
				import('../../workspaces/peers.js'),
				import('../../workspaces/prefix.js'),
				import('../../terminal/pty.js'),
				import('../../workspaces/mouse.js'),
			])
		const binding = await pty.loadHostPty().catch(() => null)
		if (binding === null) return null
		const palette = await import('../../workspaces/palette.js')
		const peers = peersModule.createPeerSource(deps.env)
		const workspacesStore = store.fileStore(
			store.workspacesFilePath(deps.env),
			() => undefined,
			store.legacySpacesFilePath(deps.env),
		)
		const restored = workspacesStore.load()
		const accounts = workspaces.storedAccounts
		const prefix =
			(deps.prefixSetting !== undefined
				? prefixModule.parsePrefix(deps.prefixSetting)
				: undefined) ?? prefixModule.DEFAULT_PREFIX

		const listeners = new Set<(chunk: string | Buffer) => void>()
		const input: HostInput = {
			on: (_event, listener) => void listeners.add(listener),
			off: (_event, listener) => void listeners.delete(listener),
		}
		const stops = new Map<() => void, () => void>()
		const output: HostOutput = {
			write: (data) => deps.realOut.write(data),
			get columns() {
				return deps.realOut.columns ?? 80
			},
			get rows() {
				return deps.realOut.rows ?? 24
			},
			on: (_event, listener) => {
				stops.set(listener, deps.proxy.onRealResize(listener))
			},
			off: (_event, listener) => {
				stops.get(listener)?.()
				stops.delete(listener)
			},
		}
		const local = new LocalSession(
			{
				proxy: deps.proxy,
				realOut: deps.realOut,
				onKey: (chunk) => {
					for (const listener of [...listeners]) listener(chunk)
					return null
				},
				requestExit: deps.requestExit,
				repaint: deps.repaint,
			},
			{ cols: deps.realOut.columns ?? 80, rows: deps.realOut.rows ?? 24 },
		)
		const host = new Host({
			input,
			output,
			binding,
			spec: (request) =>
				workspaces.sessionSpec(request, { env: deps.env, entry: deps.entry }, accounts(), [
					deps.entry,
				]),
			accounts,
			store: workspacesStore,
			...(restored ? { restored } : {}),
			inUseElsewhere: (query) => workspaces.conversationInUse(query, peers, deps.env),
			folder: {
				cwd: deps.cwd,
				name: deps.cwd.split(/[\\/]/u).filter(Boolean).pop() ?? 'session',
			},
			prefix,
			colors: palette.colorLevel(deps.env),
			mouse: mouse.resolveMouseMode(deps.env, deps.mouseSetting),
			...(deps.copyOnSelect !== undefined ? { copyOnSelect: deps.copyOnSelect } : {}),
			...(peers ? { peers } : {}),
			local: {
				session: local,
				conversationId: () => {
					try {
						return peersModule.recordForPid(peers?.records() ?? [], process.pid)?.conversationId
					} catch {
						return undefined
					}
				},
			},
		})
		host.start()
		return { host, local }
	}

	return {
		async open() {
			built ??= build().catch(() => null)
			const parts = await built
			if (parts === null) return false
			if (parts.host.visible) parts.host.focusSidebar()
			else parts.host.openWorkspaces()
			return true
		},
		async confirmExit() {
			// The workspaces screen was never opened, so there are no other sessions.
			if (built === null) return true
			const parts = await built
			if (parts === null) return true
			return parts.host.askLocalExit()
		},
		async release(stillWanted = () => true) {
			if (built === null) return false
			const parts = await built
			// A caller that gave up waiting must not get the terminal touched after it moved on.
			if (parts === null || !stillWanted()) return false
			return parts.host.releaseTerminal()
		},
		async shutdown() {
			if (built === null) return
			const parts = await built
			if (parts === null) return
			parts.local.markExited()
			parts.host.quit()
			await parts.host.done
		},
	}
}
