/**
 * Your Namzu network: machines of one person find each other on the local
 * network, show one roster of sessions, pass roles and messages, and keep the
 * safety rules of local messaging across machines.
 *
 * Host-neutral. A host supplies a {@link NetworkHost} and a discovery; the
 * terminal does so today and the desktop can later.
 *
 * @experimental
 */

export { createManualClock, systemClock } from './clock.js'
export type { ManualClock, NetworkClock } from './clock.js'

export {
	createDiscoveryHub,
	createFakeDiscovery,
	isPrivateNetworkAddress,
	privateInterfaces,
} from './discovery.js'
export type {
	Advertisement,
	DiscoveredEndpoint,
	DiscoveryHub,
	FakeDiscovery,
	ListenAddress,
	NetworkDiscovery,
	PrivateInterfaceOptions,
} from './discovery.js'

export {
	AUDIT_EVENTS,
	createFileAuditSink,
	createMemoryAuditSink,
	textHash,
} from './audit.js'
export type { AuditEntry, AuditEventName, AuditSink, FileAuditSinkOptions } from './audit.js'

export { createNetworkStore } from './store.js'
export type { NetworkStore, NetworkStoreOptions } from './store.js'

export { formatJoinCode, joinCode } from './join.js'
export type { PendingJoin } from './join.js'

export { HOLD_EXPIRY_MS, MAX_HELD_PER_TERMINAL, decideMail } from './mail-policy.js'
export type { MailDecision, MailDecisionInput, MailSetting } from './mail-policy.js'

export { createFounding, evaluateMembership, mergeMembership } from './membership.js'
export type { Admission, MembershipView, Revocation } from './membership.js'

export {
	generateSessionName,
	machineLabel,
	resolveSessionTarget,
	sessionDisplayName,
	sessionLabel,
} from './roster.js'
export type {
	LocalSession,
	RosterMachineView,
	RosterView,
	TargetResolution,
} from './roster.js'

export {
	BROWSE_WINDOW_MS,
	DEFAULT_LISTEN_PORT,
	createNamzuNetwork,
	parseHostPort,
} from './service.js'
export type {
	HeldMail,
	NetworkEvent,
	NetworkHost,
	NetworkService,
	NetworkServiceOptions,
	NetworkState,
	NetworkStatus,
	RemoteMail,
} from './service.js'

export { NetworkError } from './transport.js'
export type { NetworkErrorCode } from './transport.js'

export {
	MAX_NET_LINE_BYTES,
	MAX_PREAUTH_LINE_BYTES,
	MAX_ROLE_BYTES,
	NET_PROTOCOL,
	sanitizeName,
	sanitizeRole,
} from './wire.js'
export type { RosterSession } from './wire.js'
