import type {
	SkillPathChoiceView,
	SkillScope,
	SkillStageItemView,
} from '../shared/customize-protocol.js'

/**
 * The words and rules of the add, create and remove actions on the Customize page, as plain data:
 * no React and no engine call, so each rule can be tested alone.
 */

export const UPLOAD_SUBTITLE = 'Add a skill to this computer.'
export const UPLOAD_DROP_TEXT =
	'Drag and drop skill files here, or browse. You can add several at once.'
export const UPLOAD_HELP = [
	'A .md file must contain the skill name and description formatted in YAML.',
	'A .zip or .skill file must include a SKILL.md file.',
] as const
export const UPLOAD_CHECKED_LINE =
	'Each skill is checked when you add it: name, description, size, links and what it can run. Nothing leaves your computer.'
export const UPLOAD_HINT = 'Choose a file to continue.'
export const PROJECT_UNTRUSTED = 'Open a trusted project folder to save skills there.'
export const CREATE_HINT = 'Add a valid name and description before saving.'
export const CONNECTOR_NOTICE =
	'Only use connectors from developers you trust. Namzu cannot verify what their tools do or that they will not change.'
export const CONNECTOR_INTRO = 'Connect Namzu to your data and tools with an MCP server address.'
export const CONNECTOR_URL_HELP =
	'The https address where the server accepts MCP requests, for example https://mcp.example.com/mcp.'
export const CONNECTOR_NAME_HELP = 'Shown in the connectors list.'

export const UPLOAD_LIMIT = 20
export const DESCRIPTION_MAX = 1024
export const NAME_MAX = 64

export const SCOPES: readonly { id: SkillScope; label: string }[] = [
	{ id: 'user', label: 'Yours' },
	{ id: 'project', label: 'This project' },
]

/** A size for people: `812 B`, `12 KB`, `3.4 MB`. */
export function sizeWords(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `3 files · 12 KB`, or whatever of it is known. */
export function stageSize(item: SkillStageItemView): string {
	const parts: string[] = []
	if (item.files !== undefined) parts.push(`${item.files} ${item.files === 1 ? 'file' : 'files'}`)
	if (item.bytes !== undefined) parts.push(sizeWords(item.bytes))
	return parts.join(' · ')
}

/** The small chips on a card: what the skill can run, read from what the engine said it grants. */
export function stageChips(item: SkillStageItemView): string[] {
	const chips: string[] = []
	if (item.scripts.length > 0 || item.grants.some((line) => line.startsWith('Runs commands')))
		chips.push('Runs commands')
	if (item.grants.some((line) => line.startsWith('Pre-approves'))) chips.push('Uses tools: shell')
	if (
		item.grants.some((line) => line.startsWith('Runs commands from its hooks')) ||
		item.grants.some((line) => line.startsWith('Carries hooks')) ||
		item.findings.some((line) => line.startsWith('Hooks'))
	)
		chips.push('Has hooks')
	return chips
}

/** True when the skill can run something, so adding it needs a yes to exactly that. */
export const stageNeedsAccept = (item: SkillStageItemView): boolean =>
	item.scripts.length > 0 || item.grants.length > 0

/** The line under a card whose name is taken: replace it, or why it cannot be. */
export function collisionLine(item: SkillStageItemView, scope: SkillScope): string | undefined {
	if (!item.name) return undefined
	return item.collides?.includes(scope) ? `Replaces your skill "${item.name}"` : undefined
}

export interface CardState {
	/** The choice this card came from. */
	choice: SkillPathChoiceView
	item?: SkillStageItemView
	/** A refusal the app itself made before the engine saw the file. */
	error?: string
}

/** Whether Upload may be pressed: something to add, nothing unanswered. */
export function uploadBlocked(
	cards: readonly CardState[],
	scope: SkillScope,
	replace: ReadonlySet<string>,
	accept: ReadonlySet<string>,
): string | undefined {
	const ready = cards.filter((card) => card.item?.name && !card.item.error && !card.error)
	if (ready.length === 0) return UPLOAD_HINT
	for (const card of ready) {
		const item = card.item as SkillStageItemView
		const name = item.name as string
		if (item.collides?.includes(scope) && !replace.has(name))
			return `Choose whether to replace "${name}".`
		if (stageNeedsAccept(item) && !accept.has(name))
			return `Accept what "${name}" can run to continue.`
	}
	return undefined
}

/** The toast after an upload: how many were added, and the first failures in words. */
export function uploadToast(
	results: readonly { name: string; outcome: 'added' | 'replaced' | 'failed'; error?: string }[],
): { text: string; tone: 'success' | 'warning' | 'error' } {
	const done = results.filter((result) => result.outcome !== 'failed')
	const failed = results.filter((result) => result.outcome === 'failed')
	if (done.length === 0) return { text: failed[0]?.error ?? 'No skills were added.', tone: 'error' }
	const added =
		done.length === 1
			? `Added ${done[0]?.name}. It is available from your next message.`
			: `Added ${done.length} skills. They are available from your next message.`
	return failed.length > 0
		? {
				text: `${added} ${failed.length} could not be added: ${failed[0]?.error ?? ''}`.trim(),
				tone: 'warning',
			}
		: { text: added, tone: 'success' }
}

/** The folder name a skill name becomes: lower case, words joined by dashes. Empty when nothing is left. */
export function skillFolderName(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, NAME_MAX)
		.replace(/-+$/g, '')
}

export const hasXmlTag = (text: string): boolean => /<\/?[A-Za-z][^>]*>/.test(text)

/** What is wrong with a skill the person is writing, or nothing. */
export function createProblem(form: {
	name: string
	description: string
	instructions: string
}): string | undefined {
	if (skillFolderName(form.name) === '') return CREATE_HINT
	if (form.description.trim() === '') return CREATE_HINT
	if (form.description.length > DESCRIPTION_MAX)
		return `Description is longer than ${DESCRIPTION_MAX}.`
	if (hasXmlTag(form.description)) return 'Description cannot contain XML tags'
	if (hasXmlTag(form.name)) return 'Skill name cannot contain XML tags'
	if (form.instructions.trim() === '') return 'Write what the skill should do.'
	return undefined
}

/** `---` at the very start would be read as frontmatter; the dialog says so. */
export const startsWithFrontmatter = (instructions: string): boolean =>
	/^\s*---\s*(\r?\n|$)/.test(instructions)

export const FRONTMATTER_NOTE =
	'Instructions that start with --- are read as frontmatter. Write the instructions without it; the name and description are added for you.'

/** The words for the confirm before a skill is moved to the backups. */
export const removeTitle = 'Remove skill?'
export const removeBody = (name: string): string =>
	`"${name}" will be removed from this computer. A copy is kept in Namzu's backups, so you can put it back.`

export interface HeaderDraft {
	name: string
	value: string
}

/** A header value is an environment reference, with or without `Bearer `. */
export const HEADER_REFERENCE = /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
export const HEADER_NAME = /^[A-Za-z0-9-]+$/

export type ConnectorAuth = 'none' | 'sign-in' | 'header'

export interface ConnectorDraft {
	name: string
	url: string
	auth: ConnectorAuth
	header: HeaderDraft
}

export const emptyConnector = (): ConnectorDraft => ({
	name: '',
	url: '',
	auth: 'none',
	header: { name: '', value: '' },
})

/** What is wrong with the connector form, or nothing; the engine checks it all again. */
export function connectorProblem(draft: ConnectorDraft): string | undefined {
	const name = draft.name.trim()
	if (!name) return 'Name the connector.'
	if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
		return 'A name starts with a letter and uses only letters, digits, _ or -, up to 64 characters.'
	let url: URL
	try {
		url = new URL(draft.url.trim())
	} catch {
		return 'Enter the https address of the server.'
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		return 'The address must start with http or https.'
	if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
		return 'An http address is only allowed for this computer. Use https.'
	if (url.username || url.password) return 'Do not put a user name or password in the address.'
	if (draft.auth === 'header') {
		if (!HEADER_NAME.test(draft.header.name.trim())) return 'Name the header.'
		if (!HEADER_REFERENCE.test(draft.header.value.trim()))
			return 'A header value is written as an environment reference such as ${EXAMPLE_TOKEN}, so no secret is stored here.'
	}
	return undefined
}

/** The change `namzu/mcp/save-user-server` takes for this form. */
export function connectorChange(draft: ConnectorDraft): {
	mode: 'add'
	name: string
	url: string
	headers?: Record<string, string>
} {
	return {
		mode: 'add',
		name: draft.name.trim(),
		url: draft.url.trim(),
		...(draft.auth === 'header'
			? { headers: { [draft.header.name.trim()]: draft.header.value.trim() } }
			: {}),
	}
}
