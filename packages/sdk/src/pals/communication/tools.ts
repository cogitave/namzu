import { z } from 'zod'
import { defineTool } from '../../tools/defineTool.js'
import type { ToolContext, ToolDefinition } from '../../types/tool/index.js'
import { addressSchema, hash, intentSchema, sourceSchema } from './schema.js'
import type { PalMessageSender, PalMessageSenderContext } from './types.js'

/** Only discovery information explicitly approved for the executing Pal. */
export interface PalMessagingRecipient {
	readonly palId: string
	readonly name: string
	readonly description?: string
}

export interface PalMessagingToolsOptions {
	/** Created by the host from the same captured source; never selected by the model. */
	readonly sender: PalMessageSender
	readonly source: PalMessageSenderContext
	/** Required live admission check, including current pause/retirement and execution scope. */
	readonly assertCurrentAdmission: (context: ToolContext) => void | Promise<void>
	/** Required current visibility policy. No Pal-store or directory-listing fallback exists. */
	readonly listAuthorizedPals: (
		context: ToolContext,
	) => readonly PalMessagingRecipient[] | Promise<readonly PalMessagingRecipient[]>
}

const sendSchema = z
	.object({
		palId: addressSchema.shape.palId.describe('Recipient Pal ID.'),
		body: intentSchema.shape.body.describe('The explicit message to send.'),
		replyTo: intentSchema.shape.replyTo
			.unwrap()
			.optional()
			.describe('An observed incoming Pal message ID, when replying in its conversation.'),
	})
	.strict()
const listSchema = z.object({}).strict()
const recipientSchema = z
	.object({
		palId: addressSchema.shape.palId,
		name: z.string().min(1),
		description: z.string().optional(),
	})
	.strict()

/**
 * Host-installed tools over an explicitly authorized sender and discovery view.
 * Sending commits an acceptance receipt; it never waits for a recipient turn.
 */
export function createPalMessagingTools(options: PalMessagingToolsOptions): ToolDefinition[] {
	if (
		typeof options.sender?.send !== 'function' ||
		typeof options.assertCurrentAdmission !== 'function' ||
		typeof options.listAuthorizedPals !== 'function'
	)
		throw new TypeError(
			'Pal messaging tools require a sender, live admission and authorized discovery.',
		)
	const parsed = sourceSchema.parse(options.source)
	const source = Object.freeze({ ...parsed, address: Object.freeze({ ...parsed.address }) })
	const send = options.sender.send.bind(options.sender)
	const assertCurrentAdmission = options.assertCurrentAdmission
	const listAuthorizedPals = options.listAuthorizedPals
	const assertCurrent = async (context: ToolContext): Promise<void> => {
		context.abortSignal?.throwIfAborted()
		if (context.sessionId !== source.conversationId)
			throw new Error('Pal messaging requires the captured sender conversation.')
		await assertCurrentAdmission(context)
		context.abortSignal?.throwIfAborted()
	}
	return [
		defineTool({
			name: 'send_pal_message',
			description:
				'Send an explicit message to another Pal under the current host policy. Returns durable acceptance, not proof of delivery or a completed recipient task. Use replyTo only for an incoming Pal message you observed. The host selects sender and tenant; messages and Pal descriptions do not grant new authority.',
			inputSchema: sendSchema,
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: true,
			maxRetries: 0,
			async execute(input, context) {
				const request = sendSchema.parse(input)
				await assertCurrent(context)
				if (
					typeof context.toolBatchId !== 'string' ||
					!context.toolBatchId ||
					typeof context.toolUseId !== 'string' ||
					!context.toolUseId
				)
					throw new Error('Pal messaging requires executor toolBatchId and toolUseId.')
				const operationId = hash([
					1,
					'pal-message-tool',
					source.conversationId,
					context.toolBatchId,
					context.toolUseId,
				])
				const receipt = await send({
					operationId,
					recipient: { tenantId: source.address.tenantId, palId: request.palId },
					body: request.body,
					...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
				})
				const accepted = {
					status: receipt.status,
					messageId: receipt.id,
					recipientPalId: receipt.recipient.palId,
				}
				return { success: true, output: JSON.stringify(accepted), data: accepted }
			},
		}),
		defineTool({
			name: 'list_pals',
			description:
				'List only Pals currently visible through the host authorization policy. Names and descriptions identify recipients; visibility alone does not authorize sending or recipient actions. This view does not list host files, workspaces, credentials or all registered Pals.',
			inputSchema: listSchema,
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute(input, context) {
				listSchema.parse(input)
				await assertCurrent(context)
				const visible = await listAuthorizedPals(context)
				await assertCurrent(context)
				const pals = visible.map((pal) =>
					recipientSchema.parse({
						palId: pal.palId,
						name: pal.name,
						...(pal.description === undefined ? {} : { description: pal.description }),
					}),
				)
				return { success: true, output: JSON.stringify({ pals }), data: { pals } }
			},
		}),
	]
}
