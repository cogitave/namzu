import type { MailSetting, NetworkState, RosterView } from '@namzu/sdk'

/** A join request waiting for an Allow, as a screen or a command shows it. No key, no connection. */
export interface JoinRequestView {
	readonly requestId: string
	/** What the joining machine calls itself. */
	readonly name: string
	/** The short code both screens show, `482 913`. */
	readonly code: string
	readonly sourceAddr: string
	readonly expiresAt: number
}

/** Mail from another machine waiting for the person. */
export interface RemoteHeldView {
	readonly id: string
	readonly machineName: string
	readonly fromSessionName: string
	readonly fromMode: string
	readonly toSessionRef: string
	readonly reason: string
	readonly text: string
	readonly expiresAt: number
}

/** How a message this machine's sessions sent to another machine ended; a held one resolves later. */
export interface MailOutcomeView {
	readonly id: string
	/** The ref of the local session that sent it. */
	readonly senderRef: string
	/** Who it was sent to: `machine / session`. */
	readonly to: string
	readonly outcome: 'delivered' | 'queued' | 'held' | 'refused' | 'expired'
	readonly detail?: string
	readonly at: number
}

/** Everything the screens and `namzu peers status` say about the network, as plain data. */
export interface NetworkSummary {
	readonly state: NetworkState
	readonly reason?: string
	readonly machine?: { readonly id: string; readonly name: string; readonly role?: string }
	readonly members: number
	readonly port?: number
	readonly nearbyNetworks: number
	readonly joinRequests: readonly JoinRequestView[]
	readonly held: readonly RemoteHeldView[]
	/** This machine asked a nearby network to let it in and waits for an Allow elsewhere. */
	readonly joining?: { readonly code: string; readonly endpoint: string }
	/** How the last request to join ended. */
	readonly lastJoin?: {
		readonly result: 'joined' | 'denied' | 'expired' | 'refused'
		readonly at: number
	}
	/** This machine was removed from the network and starts over. */
	readonly removed?: boolean
	/** The latest endings of messages sent from this machine, oldest first (at most 32). */
	readonly outcomes: readonly MailOutcomeView[]
}

export type SendReceipt = {
	readonly id?: string
	readonly status: 'queued' | 'held' | 'refused'
	readonly reason?: string
}

/** What a terminal or a command line can ask of the network on this machine. */
export interface NetworkControl {
	summary(): Promise<NetworkSummary>
	roster(): Promise<RosterView>
	allow(query: string): Promise<JoinRequestView>
	deny(query: string): Promise<JoinRequestView>
	/** Remove a machine by name or machine id prefix; `cascade` also removes the machines it admitted. */
	remove(
		machine: string,
		options?: { readonly cascade?: boolean; readonly dryRun?: boolean },
	): Promise<{ readonly removed: readonly string[]; readonly admitted: readonly string[] }>
	rename(name: string, machine?: string): Promise<void>
	/** `target` is a session (`name`, `machine/name`, `[ref]`) or a machine (`machine/`). `null` clears. */
	setRole(
		target: string,
		role: string | null,
	): Promise<{ readonly status: 'applied' | 'refused'; readonly reason?: string }>
	send(
		target: string,
		text: string,
		from: { readonly sessionRef: string; readonly sessionName: string; readonly mode: string },
	): Promise<SendReceipt | undefined>
	add(hostPort: string): Promise<'join-requested' | 'added'>
	/** Ask a nearby network to let this machine in; resolves when the request is made, not decided. */
	join(endpoint?: string): Promise<{ readonly networks: readonly string[] }>
	allowHeld(id: string): Promise<void>
	denyHeld(id: string): Promise<void>
	/** A remote message was taken into a turn here: tell its sender. */
	reportDelivered(machineId: string, mailId: string, sessionRef: string): Promise<void>
}

export type NetworkSettings = {
	readonly enabled: 'auto' | boolean
	readonly acceptMail: MailSetting
	readonly machineName?: string
}
