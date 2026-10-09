import type { ConversationView, ProjectGitView, ProjectView } from '../shared/protocol.js'

/** How long the pointer rests on a row before its card opens. */
export const HOVER_CARD_DELAY_MS = 450

/** "now", "5m", "3h" or "2d": the same short form the sidebar has always used. */
export function relativeAge(updatedAt: string, now: number): string {
	const age = now - Date.parse(updatedAt)
	if (!Number.isFinite(age)) return ''
	if (age < 60_000) return 'now'
	if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`
	if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`
	return `${Math.floor(age / 86_400_000)}d`
}

export interface HoverCardModel {
	title: string
	/** The engine that answers in this conversation, as the engine popup names it. */
	engine: string
	/** The last thing said, when this window has the conversation loaded. */
	preview?: string
	age: string
	environment: { kind: 'this-computer' | 'pal-computer'; label: string }
	/** Absent for a conversation that has no project folder of its own. */
	folder?: string
	/** Absent unless the project exposes a branch; a detached head is not guessed at. */
	branch?: string
	/** Whether the card needs the project's repository facts. */
	wantsGit: boolean
}

/** Whether the project is an ordinary folder the host can read repository facts for. */
export function projectHasRepository(project: ProjectView): boolean {
	return project.trusted && !project.isChat && !project.palId && project.path.length > 0
}

const ENGINE_NAMES = {
	namzu: 'Namzu',
	'codex-cli': 'Codex CLI',
	'claude-code': 'Claude Code',
} as const

/** The last message with words in it, one short line; the person's own lines lead with "You:". */
export function lastMessagePreview(
	messages: readonly { role: 'user' | 'assistant'; text: string }[] | undefined,
	limit = 120,
): string | undefined {
	for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
		const message = messages?.[index]
		const text = message?.text.replace(/\s+/g, ' ').trim()
		if (!message || !text) continue
		const line = message.role === 'user' ? `You: ${text}` : text
		const letters = [...line]
		return letters.length > limit ? `${letters.slice(0, limit).join('').trimEnd()}…` : line
	}
	return undefined
}

export function hoverCardModel(input: {
	conversation: ConversationView
	project: ProjectView
	git?: ProjectGitView | null
	messages?: readonly { role: 'user' | 'assistant'; text: string }[]
	now: number
}): HoverCardModel {
	const { conversation, project, git, now } = input
	const preview = lastMessagePreview(input.messages)
	const pal = Boolean(conversation.palId || project.palId)
	const folder = project.isChat || pal ? undefined : project.name
	const branch = projectHasRepository(project) && git?.branch ? git.branch : undefined
	return {
		title: conversation.title,
		engine: ENGINE_NAMES[conversation.harness ?? 'namzu'],
		...(preview ? { preview } : {}),
		age: relativeAge(conversation.updatedAt, now),
		environment: pal
			? { kind: 'pal-computer', label: "A Pal's computer" }
			: { kind: 'this-computer', label: 'This computer' },
		...(folder ? { folder } : {}),
		...(branch ? { branch } : {}),
		wantsGit: projectHasRepository(project),
	}
}

export interface HoverIntent {
	/** The pointer arrived; opens after the delay unless cancelled first. */
	enter(): void
	/** Closes the card now, or stops it from opening. */
	cancel(): void
}

/** One row's hover timing. The clock is injected so a test can advance it. */
export function createHoverIntent(options: {
	delay?: number
	onOpen: () => void
	onClose: () => void
	setTimer?: (run: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}): HoverIntent {
	const set = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
	const clear = options.clearTimer ?? ((handle) => clearTimeout(handle as never))
	let timer: unknown
	let pending = false
	let open = false
	return {
		enter() {
			if (pending || open) return
			pending = true
			timer = set(() => {
				pending = false
				open = true
				options.onOpen()
			}, options.delay ?? HOVER_CARD_DELAY_MS)
		},
		cancel() {
			if (pending) {
				clear(timer)
				pending = false
			}
			if (open) {
				open = false
				options.onClose()
			}
		},
	}
}

/** Repository facts per project, so hovering rows asks the host once, not once per hover. */
export function createGitCache(
	load: (projectId: string) => Promise<ProjectGitView | null>,
	options: { ttl?: number; now?: () => number } = {},
) {
	const ttl = options.ttl ?? 30_000
	const now = options.now ?? Date.now
	const entries = new Map<string, { at: number; value: ProjectGitView | null }>()
	const inflight = new Map<string, Promise<ProjectGitView | null>>()
	return {
		peek(projectId: string): ProjectGitView | null | undefined {
			const hit = entries.get(projectId)
			return hit && now() - hit.at < ttl ? hit.value : undefined
		},
		get(projectId: string): Promise<ProjectGitView | null> {
			const hit = entries.get(projectId)
			if (hit && now() - hit.at < ttl) return Promise.resolve(hit.value)
			const pending = inflight.get(projectId)
			if (pending) return pending
			const request = load(projectId).then(
				(value) => {
					entries.set(projectId, { at: now(), value })
					inflight.delete(projectId)
					return value
				},
				() => {
					inflight.delete(projectId)
					return null
				},
			)
			inflight.set(projectId, request)
			return request
		},
	}
}
