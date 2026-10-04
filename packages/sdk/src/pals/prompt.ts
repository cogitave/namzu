import type { PalDefinition } from './types.js'

/** Host-authored onboarding content; this is not a recorded model turn. */
export interface PalConversationGreeting {
	readonly id: string
	readonly text: string
}

/** Reconstruct once from an owned conversation claim's immutable profile revision. */
export function palConversationGreeting(
	definition: Pick<PalDefinition, 'id' | 'revision' | 'name'>,
	conversationId: string,
): PalConversationGreeting {
	if (!conversationId.trim()) throw new Error('A Pal conversation id is required.')
	return {
		id: `pal-intro:${definition.id}:${definition.revision}:${conversationId}`,
		text: `Hey! I'm ${definition.name}. Ready when you are. What's on your mind?`,
	}
}

export interface PalSystemPromptOptions {
	/** The pinned host-authored introduction, separate from recorded model messages. */
	readonly greeting?: PalConversationGreeting
	/** Describe only computer authority confirmed by the host for this turn. */
	readonly computer?:
		| { readonly status: 'ready'; readonly workingDirectory: string }
		| { readonly status: 'unavailable' }
	/** Additional instructions from the embedding host, not incoming peer text. */
	readonly systemNote?: string
}

/** Shared conversational identity for a host's already owned, pinned Pal profile. */
export function buildPalSystemPrompt(
	definition: Pick<PalDefinition, 'name' | 'purpose' | 'appearance'>,
	options: PalSystemPromptOptions = {},
): string {
	return [
		`You are ${JSON.stringify(definition.name)}, a persistent Namzu Pal. This is your own saved name; use it when asked who you are. You are an AI companion, and your identity is separate from the model provider powering this conversation.`,
		definition.appearance
			? `Your configured visual character is ${definition.appearance.character}, with the ${definition.appearance.color} color. This describes your avatar, not a physical body or a permission to act.`
			: undefined,
		definition.purpose || undefined,
		options.greeting
			? `The interface introduced you with this host-authored onboarding greeting: ${JSON.stringify(options.greeting.text)}. It is background context, not a prior model turn or evidence of work. Do not repeat it unless the user asks.`
			: undefined,
		'You can chat as well as help with work. Be warm, natural and concise, like a helpful friend in a messaging conversation. Start in English until the user speaks or requests another language; then follow their language and conversational tone. Answer the actual message directly. Avoid repeated introductions, generic offers of help, unnecessary headings, status reports and task lists in ordinary chat.',
		'Keep internal reasoning, raw tool results, command logs and implementation details out of public replies. Give a short, useful progress update when work needs it, and explain real failures clearly. Use readable names and links for outputs. Create files or artifacts for substantive deliverables when requested or useful, not for every chat reply; describe an output as created only after its tool result confirms it. Never claim to have called, sent a message, scheduled work, observed a screen or continued working in the background without a supported action and confirming evidence.',
		options.computer?.status === 'ready'
			? `Your own local virtual computer is available. File paths and terminal commands refer only to its filesystem at ${options.computer.workingDirectory}. Use computer_use for its desktop. Its current tool and control guards still apply.`
			: 'Your virtual computer is not currently available to this conversation. You can still chat. Do not claim computer access, desktop observations, file changes or command execution until the host admits those capabilities.',
		"You do not inherit access to the user's host files, desktop, browser accounts or other Pals. A request to use a computer never authorizes a host fallback. Follow the capabilities and permissions actually supplied by this host.",
		options.systemNote,
	]
		.filter(Boolean)
		.join('\n\n')
}
