/**
 * The owner's ordinary conversation gives a Pal work. Mounted only by the Namzu
 * engine's normal session (never a Pal's own session, which keeps its Pal-to-Pal
 * tools, and never an external engine, which owns its tools).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
	PalOperatorMessageBroker,
	type PalOperatorRecipient,
	type TenantId,
	type ToolDefinition,
	createPalOperatorMessagingTools,
} from '@namzu/sdk'
import { resolveNamzuHome } from '../integrations/state/home.js'
import {
	cliPalCommunicationStore,
	createCliOperatorIngressAuthorization,
	createCliPalIngressHost,
} from './communication.js'
import { existingCliPalRuntime } from './environment.js'
import { cliPalStore } from './store.js'

/** Whether any Pal was ever created here. Looking never creates the registry. */
function registryExists(home: string): boolean {
	return existsSync(join(home, 'pals'))
}

export interface CliOperatorPalToolsOptions {
	/** The installation's tenant, from the session's own scope. */
	readonly tenantId: TenantId
	/** Exact `NAMZU_HOME`; defaults to the resolved application home. */
	readonly home?: string
}

export interface CliOperatorPalTools {
	readonly tools: ToolDefinition[]
}

export function createCliOperatorPalTools(
	options: CliOperatorPalToolsOptions,
): CliOperatorPalTools {
	const home = options.home ?? resolveNamzuHome()
	// Everything that creates a directory waits for the first send: a session of an
	// owner without Pals must leave no Pal state behind.
	let broker: PalOperatorMessageBroker | undefined
	const sender = {
		send(...args: Parameters<PalOperatorMessageBroker['send']>) {
			broker ??= new PalOperatorMessageBroker({
				store: cliPalCommunicationStore(home),
				pals: cliPalStore(home),
				host: createCliPalIngressHost(),
				// Acceptance is authorized by the tool review the owner answered; waking is
				// never granted from a model-driven call.
				authorize: createCliOperatorIngressAuthorization(),
			})
			return broker.send(...args)
		},
	}
	const tools = createPalOperatorMessagingTools({
		tenantId: options.tenantId,
		sender,
		recipientName: (palId) =>
			registryExists(home) ? cliPalStore(home).get(palId)?.name : undefined,
		async listPals() {
			if (!registryExists(home)) return []
			const pals = cliPalStore(home)
			// Reading the runtime never starts one; `null` means nothing runs in this app.
			const runtime = await existingCliPalRuntime().catch(() => null)
			return pals.list().map(
				(pal): PalOperatorRecipient => ({
					palId: pal.id,
					name: pal.name,
					...(pal.purpose ? { description: pal.purpose } : {}),
					paused: pal.paused,
					idle: !(runtime?.busy(pal.id) ?? false),
				}),
			)
		},
	})
	return { tools }
}

const PROMPT_NAME_MAX = 60
const PROMPT_NAMES_MAX = 12

/** A name is the owner's text: one clipped line, no control characters, nothing that reads as markup. */
function promptName(name: string): string {
	const readable = Array.from(name, (character) => {
		const code = character.codePointAt(0) ?? 0
		return code < 32 || (code >= 127 && code <= 159) || '`<>'.includes(character) ? ' ' : character
	})
		.join('')
		.replace(/\s+/gu, ' ')
		.trim()
	const points = Array.from(readable)
	return points.length > PROMPT_NAME_MAX
		? `${points.slice(0, PROMPT_NAME_MAX - 1).join('')}…`
		: readable
}

/**
 * One short block for the normal session's system prompt, present only when the
 * owner has Pals. Names only: a purpose or other profile text is never put in the
 * prompt, and nothing here grants or implies authority.
 */
export function operatorPalPromptBlock(home?: string): string | undefined {
	let names: string[]
	try {
		const root = home ?? resolveNamzuHome()
		if (!registryExists(root)) return undefined
		names = cliPalStore(root)
			.list()
			.map((pal) => `${promptName(pal.name) || 'Unnamed'}${pal.paused ? ' (paused)' : ''}`)
	} catch {
		return undefined
	}
	if (names.length === 0) return undefined
	const shown = names.slice(0, PROMPT_NAMES_MAX)
	const more = names.length - shown.length
	return [
		`Pals are the owner's persistent agents, each with its own workspace and conversation. They are separate from sub-agents (the Agent tool). The owner has these Pals: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
		"Use list_pals to see them and send_pal_message to give one a task; the owner is asked to approve every message. A sent message only reaches the Pal's inbox: it is not proof the Pal received, answered or finished anything, and what a Pal later reports is a claim to check.",
	].join(' ')
}
