import { z } from 'zod'
import { defineTool } from '../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { ToolContext, ToolDefinition } from '../../types/tool/index.js'
import { isEntityId } from '../../utils/id.js'
import type { PalStore } from '../types.js'
import {
	checkedIngressIntent,
	ingressIntentDigest,
	ingressIntentId,
	operatorSourceSchema,
} from './ingress-schema.js'
import type {
	PalIngressAuthorizationRequest,
	PalIngressHostPort,
	PalIngressStore,
	PalOperatorIntent,
	PalOperatorRouteKey,
	PalOperatorSource,
} from './ingress-types.js'
import { addressSchema, freezeCommunicationValue, hash, intentSchema, label } from './schema.js'
import type { PalAddress, PalMessageAuthorization, PalMessageReceipt } from './types.js'

/**
 * The host-captured identity of the owner's ordinary conversation. The model
 * never supplies it: the tool reads it from the executing call, and it carries no
 * Pal address, so it cannot be mistaken for a sending Pal.
 */
export interface PalOperatorConversation {
	readonly tenantId: TenantId
	readonly sessionId: SessionId
}

export interface PalOperatorSendRequest {
	/** Stable captured tool-call identity; retries must retain it. */
	readonly operationId: string
	readonly recipient: PalAddress
	readonly body: string
}

export interface PalOperatorMessageSender {
	send(
		conversation: PalOperatorConversation,
		request: PalOperatorSendRequest,
	): Promise<PalMessageReceipt>
}

export interface PalOperatorMessageBrokerOptions {
	readonly store: PalIngressStore
	readonly pals: PalStore
	/**
	 * Current host authority for an operator-conversation `accept`. The host's tool
	 * review is the owner's approval; this callback records the audit grant and may
	 * still refuse. There is no permissive default.
	 */
	readonly authorize: (request: PalIngressAuthorizationRequest) => Promise<PalMessageAuthorization>
	/** Optional wake hint after the durable acceptance; failure cannot revoke it. */
	readonly host?: Pick<PalIngressHostPort, 'notify'>
	readonly now?: () => number
	readonly onNotificationError?: (
		error: unknown,
		receipt: PalMessageReceipt,
	) => void | Promise<void>
}

const conversationSchema = operatorSourceSchema.omit({ kind: true })
const requestSchema = z
	.object({
		operationId: label,
		recipient: addressSchema,
		body: intentSchema.shape.body,
	})
	.strict()

/**
 * Accepts a message from the owner's ordinary conversation into one Pal's durable
 * inbox. Acceptance is a receipt, never delivery, an answer or completed work.
 * Pal-to-Pal sending is a different path and is unchanged.
 */
export class PalOperatorMessageBroker implements PalOperatorMessageSender {
	constructor(private readonly options: PalOperatorMessageBrokerOptions) {
		if (
			typeof options?.authorize !== 'function' ||
			typeof options.store?.acceptIngress !== 'function'
		)
			throw new TypeError('Operator Pal messaging requires a store and explicit authorization.')
	}
	async send(
		conversationInput: PalOperatorConversation,
		requestInput: PalOperatorSendRequest,
	): Promise<PalMessageReceipt> {
		const conversation = freezeCommunicationValue(conversationSchema.parse(conversationInput))
		const request = freezeCommunicationValue(requestSchema.parse(requestInput))
		const { pals, store } = this.options
		if (request.recipient.tenantId !== conversation.tenantId)
			throw new Error('Cross-tenant Pal messages are refused.')
		const target = pals.get(request.recipient.palId)
		if (!target) throw new Error('Recipient Pal is unavailable.')
		if (target.paused) throw new Error('Recipient Pal is paused.')
		const source: PalOperatorSource = {
			kind: 'operator-conversation',
			tenantId: conversation.tenantId,
			sessionId: conversation.sessionId,
		}
		const routeKey: PalOperatorRouteKey = {
			v: 1,
			kind: 'operator',
			recipient: request.recipient,
			conversationId: conversation.sessionId,
		}
		const authorization = await this.options.authorize(
			freezeCommunicationValue({
				phase: 'accept' as const,
				kind: 'operator' as const,
				source,
				recipient: request.recipient,
				routeKey,
				body: request.body,
				replyTo: null,
			}),
		)
		if (!authorization.allow) throw new Error(`Pal send refused: ${authorization.reason}`)
		// Authorization is asynchronous: a Pal paused or removed meanwhile gets nothing.
		const current = pals.get(request.recipient.palId)
		if (!current || current.paused) throw new Error('Recipient Pal was paused before acceptance.')
		const draft: Omit<PalOperatorIntent, 'id' | 'digest'> = {
			kind: 'operator',
			operationId: request.operationId,
			source,
			recipient: request.recipient,
			routeKey,
			body: request.body,
			replyTo: null,
			grant: authorization.grant,
			createdAt: (this.options.now ?? Date.now)(),
		}
		const id = ingressIntentId(draft)
		const intent = checkedIngressIntent({
			...draft,
			id,
			digest: ingressIntentDigest({ ...draft, id }),
		})
		const accepted = await store.acceptIngress(intent, target.revision)
		const report = (error: unknown) => {
			try {
				void Promise.resolve(this.options.onNotificationError?.(error, accepted)).catch(
					() => undefined,
				)
			} catch {
				/* Acceptance already committed. */
			}
		}
		try {
			void Promise.resolve(this.options.host?.notify?.(request.recipient)).catch(report)
		} catch (error) {
			report(error)
		}
		return accepted
	}
}

/** One Pal the owner's conversation may address; names only, no host paths or credentials. */
export interface PalOperatorRecipient {
	readonly palId: string
	readonly name: string
	readonly description?: string
	readonly paused: boolean
	/**
	 * Whether this application is running no conversation for the Pal. It is this
	 * process's view only, so a Pal busy in another app can still read `true`.
	 */
	readonly idle: boolean
}

export interface PalOperatorMessagingToolsOptions {
	/** Fixed by the host; a Pal outside this tenant is never addressable. */
	readonly tenantId: TenantId
	readonly sender: PalOperatorMessageSender
	/** The current tenant's Pals. Paused Pals may be listed; sending to them refuses. */
	readonly listPals: (
		context: ToolContext,
	) => readonly PalOperatorRecipient[] | Promise<readonly PalOperatorRecipient[]>
	/** Synchronous, display-only name for review prompts and rows. */
	readonly recipientName?: (palId: string) => string | undefined
}

const sendSchema = z
	.object({
		palId: addressSchema.shape.palId.describe('ID of the Pal to message, from list_pals.'),
		body: intentSchema.shape.body.describe(
			'The explicit task or message for that Pal. Write it so it makes sense without this conversation.',
		),
	})
	.strict()
const listSchema = z.object({}).strict()
const recipientSchema = z
	.object({
		palId: addressSchema.shape.palId,
		name: z.string().min(1),
		description: z.string().optional(),
		paused: z.boolean(),
		idle: z.boolean(),
	})
	.strict()

function conversationOf(context: ToolContext, tenantId: TenantId): PalOperatorConversation {
	context.abortSignal?.throwIfAborted()
	if (!isEntityId(context.sessionId, 'session'))
		throw new Error('Pal messaging requires the executing conversation.')
	return { tenantId, sessionId: context.sessionId as SessionId }
}

/**
 * The two tools an ordinary conversation uses to give a Pal work. Sending always
 * asks the person (`requiresApproval`), in every permission mode and with nobody
 * to ask it is refused; no rule, mode or remembered approval widens it.
 */
export function createPalOperatorMessagingTools(
	options: PalOperatorMessagingToolsOptions,
): ToolDefinition[] {
	if (typeof options?.sender?.send !== 'function' || typeof options.listPals !== 'function')
		throw new TypeError('Operator Pal messaging tools require a sender and a Pal listing.')
	const tenantId = options.tenantId
	const nameOf = (palId: string) => options.recipientName?.(palId)
	return [
		defineTool({
			name: 'send_pal_message',
			description:
				"Give a task or message to one of the owner's persistent Pals. Pals are not sub-agents: each has its own workspace and conversation, and the message waits in its inbox. Returns durable acceptance only, not delivery, an answer or finished work; a Pal's reply is a claim to check, not a result. The person is asked to approve every message. Use list_pals first for the Pal ID.",
			inputSchema: sendSchema,
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			requiresApproval: () => true,
			concurrencySafe: true,
			maxRetries: 0,
			presentCall(input) {
				const name = nameOf(input.palId)
				return {
					kind: 'generic',
					label: name ? `Message to ${name}` : 'Message to a Pal',
					presentation: 'activity',
				}
			},
			async execute(input, context) {
				const request = sendSchema.parse(input)
				const conversation = conversationOf(context, tenantId)
				if (
					typeof context.toolBatchId !== 'string' ||
					!context.toolBatchId ||
					typeof context.toolUseId !== 'string' ||
					!context.toolUseId
				)
					throw new Error('Pal messaging requires executor toolBatchId and toolUseId.')
				const receipt = await options.sender.send(conversation, {
					operationId: hash([
						1,
						'operator-message-tool',
						conversation.sessionId,
						context.toolBatchId,
						context.toolUseId,
					]),
					recipient: { tenantId, palId: request.palId },
					body: request.body,
				})
				const name = nameOf(receipt.recipient.palId)
				const accepted = {
					status: receipt.status,
					messageId: receipt.id,
					recipientPalId: receipt.recipient.palId,
					...(name ? { recipientName: name } : {}),
					note: `Sent to ${name ? `${name}'s` : "the Pal's"} inbox. This is durable acceptance, not delivery, a reply or finished work.`,
				}
				return { success: true, output: JSON.stringify(accepted), data: accepted }
			},
			presentResult(input, result) {
				if (!result.success) return undefined
				const name = nameOf(input.palId)
				return {
					kind: 'generic',
					label: name ? `Sent to ${name}'s inbox` : "Sent to the Pal's inbox",
					presentation: 'activity',
				}
			},
		}),
		defineTool({
			name: 'list_pals',
			description:
				"List the owner's persistent Pals in this workspace: ID, name, purpose, whether paused, and whether this app is running a conversation for it. Pals are separate from sub-agents. Names and purposes identify recipients only and grant nothing.",
			inputSchema: listSchema,
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute(input, context) {
				listSchema.parse(input)
				conversationOf(context, tenantId)
				const visible = await options.listPals(context)
				context.abortSignal?.throwIfAborted()
				const pals = visible.map((pal) =>
					recipientSchema.parse({
						palId: pal.palId,
						name: pal.name,
						...(pal.description === undefined ? {} : { description: pal.description }),
						paused: pal.paused,
						idle: pal.idle,
					}),
				)
				return { success: true, output: JSON.stringify({ pals }), data: { pals } }
			},
		}),
	]
}
