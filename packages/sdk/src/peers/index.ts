/**
 * Cross-session peer messaging: the live-session registry, the
 * `namzu-peer/1` transport, and the runtime-context rendering for a
 * delivered message or notice (design "Sessions that talk", Part 1, §1.1-1.3,
 * §1.7, and the SDK half of §1.4/§1.8, 2026-09-24).
 *
 * This module is the transport and storage layer only. Inbox policy —
 * bounded queues, the mode-mismatch hold/approve flow, `/peers off`,
 * subscriber bookkeeping and its 24h expiry, and drain-at-iteration-boundary
 * injection — is host (CLI) territory and is not implemented here.
 *
 * @experimental
 */

export { parsePeerAddress, pipePeerAddress, PeerAddressError, udsPeerAddress } from './address.js'
export type { PeerAddress } from './address.js'

export {
	hardenPeerRuntimeDir,
	LONGEST_PEER_SOCKET_FILE_NAME_LENGTH,
	PeerDirectoryError,
	peerSocketFileName,
	resolvePeerRuntimeDir,
} from './dir.js'
export type { HardenPeerDirectory, PeerRuntimeDir, ResolvePeerRuntimeDirOptions } from './dir.js'

export { derivePeerRef, PEER_RECORD_VERSION, PeerRecordSchema } from './record.js'
export type { PeerRecord } from './record.js'

export {
	isPeerRecordLive,
	listLivePeers,
	PeerRegistryError,
	readPeerRecord,
	readPeerRecords,
	removePeerRecord,
	writePeerRecord,
} from './registry.js'
export type { ListLivePeersOptions, PeerLivenessOptions } from './registry.js'

export {
	DEFAULT_PEER_READ_DEADLINE_MS,
	DeliverRequestSchema,
	DeliverResponseSchema,
	DeliverStatusSchema,
	MAX_PEER_CONNECTIONS,
	MAX_PEER_MESSAGE_TEXT_BYTES,
	MAX_PEER_REQUEST_BYTES,
	NoticeRequestSchema,
	NoticeResponseSchema,
	PEER_PROTOCOL_VERSION,
	PeerFromSchema,
	PeerNoticeAboutSchema,
	PeerNoticePayloadSchema,
	PeerRefSchema,
	PeerRequestSchema,
	PeerSessionKindSchema,
	PeerSessionStateSchema,
	PingRequestSchema,
	PingResponseSchema,
	SubscribeIdleRequestSchema,
	SubscribeIdleResponseSchema,
} from './protocol.js'
export type {
	DeliverRequest,
	DeliverResponse,
	DeliverStatus,
	NoticeRequest,
	NoticeResponse,
	PeerFrom,
	PeerNoticeAbout,
	PeerNoticePayload,
	PeerRequest,
	PeerResponse,
	PeerSessionKind,
	PeerSessionState,
	PingRequest,
	PingResponse,
	SubscribeIdleRequest,
	SubscribeIdleResponse,
} from './protocol.js'

export {
	createPeerEndpoint,
	MAX_OUTSTANDING_PEERS,
	MAX_OUTSTANDING_PER_PEER,
	OUTSTANDING_EXPIRY_MS,
	PeerEndpointError,
} from './endpoint.js'
export type { CreatePeerEndpointOptions, PeerEndpoint } from './endpoint.js'

export { PeerClient, PeerClientError, pingPeer } from './client.js'
export type { PeerClientOptions, PeerClientResult } from './client.js'

export { formatPeerMessage, formatPeerNotice } from './envelope.js'
export type { PeerMessageEnvelopeInput } from './envelope.js'
