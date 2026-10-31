/**
 * Opening the spaces screen from the running conversation.
 *
 * Imported on the first `←` only (through a dynamic import in `index.tsx`), so a
 * plain `namzu` pays nothing for it at startup: the host, the terminal emulator
 * and the pseudo-terminal binding all load here.
 */

import type { HostInput, HostOutput, SpacesHost } from '../../spaces/host.js'
import { LocalSession } from './local.js'
import type { TerminalProxy } from './proxy.js'

export interface SpacesEntryDeps {
	readonly proxy: TerminalProxy
	/** The real terminal. */
	readonly realOut: NodeJS.WriteStream
	readonly env: NodeJS.ProcessEnv
	readonly cwd: string
	/** The program that starts a session (the CLI's own entry file). */
	readonly entry: string
	readonly prefixSetting: string | undefined
	/** Ends the conversation the way `/exit` does. */
	readonly requestExit: () => void
	/** Has the App clear the screen and print its whole transcript again. */
	readonly repaint: () => void
}

export interface SpacesEntry {
	/** Shows the spaces screen, or moves the keyboard to its sidebar when it is already up. False when it cannot be shown here. */
	open(): Promise<boolean>
	/** The conversation wants to end: false when it was asked to stay because other sessions are mid-turn. */
	confirmExit(): Promise<boolean>
	/** The conversation ended: hangs up the other sessions and gives the terminal back. */
	shutdown(): Promise<void>
}

export function createSpacesEntry(deps: SpacesEntryDeps): SpacesEntry {
	let built: Promise<{ host: SpacesHost; local: LocalSession } | null> | null = null

	const build = async (): Promise<{
		host: SpacesHost
		local: LocalSession
	} | null> => {
		const [{ SpacesHost: Host }, spaces, store, peersModule, prefixModule, pty] = await Promise.all(
			[
				import('../../spaces/host.js'),
				import('../../commands/spaces.js'),
				import('../../spaces/store.js'),
				import('../../spaces/peers.js'),
				import('../../spaces/prefix.js'),
				import('../../terminal/pty.js'),
			],
		)
		const binding = await pty.loadHostPty().catch(() => null)
		if (binding === null) return null
		const palette = await import('../../spaces/palette.js')
		const peers = peersModule.createPeerSource(deps.env)
		const spacesStore = store.fileStore(store.spacesFilePath(deps.env), () => undefined)
		const restored = spacesStore.load()
		const accounts = spaces.storedAccounts
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
				spaces.sessionSpec(request, { env: deps.env, entry: deps.entry }, accounts(), [deps.entry]),
			accounts,
			store: spacesStore,
			...(restored ? { restored } : {}),
			inUseElsewhere: (query) => spaces.conversationInUse(query, peers, deps.env),
			folder: {
				cwd: deps.cwd,
				name: deps.cwd.split(/[\\/]/u).filter(Boolean).pop() ?? 'session',
			},
			prefix,
			truecolor: palette.advertisesTruecolor(deps.env),
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
			else parts.host.openSpaces()
			return true
		},
		async confirmExit() {
			// The spaces screen was never opened, so there are no other sessions.
			if (built === null) return true
			const parts = await built
			if (parts === null) return true
			return parts.host.askLocalExit()
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
