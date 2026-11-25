/**
 * Skills a server offers, as the wire carries them.
 *
 * A server that declares the `io.modelcontextprotocol/skills` extension
 * answers `skills/list` (paged by `cursor`) with entries naming a
 * `SKILL.md` and, optionally, the files beside it. Everything in an entry is
 * the SERVER's text: this module is the gate every entry passes before
 * anything else reads it. It is pure (no I/O, no clock), so every refusal is
 * a reason code a test can name.
 *
 * Limits are enforced before any body is read, so a hostile listing cannot
 * cost memory or prompt budget beyond the caps below.
 */

/** The extension's identifier, in both the client's and the server's `extensions`. */
export const MCP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'

/** The file every skill is read from, at the end of its entry's `uri`. */
export const MCP_SKILL_FILE = 'SKILL.md'

export const MCP_SKILL_LIMITS = Object.freeze({
	/** Skills kept per server; further valid entries are dropped. */
	maxSkills: 100,
	/** `skills/list` pages read per refresh. */
	maxPages: 20,
	/** Serialized size of everything one server listed, in bytes. */
	maxListingBytes: 512 * 1024,
	/** Files one skill may declare, `SKILL.md` included. */
	maxFiles: 512,
	/** Declared bytes of all of one skill's files. */
	maxTotalBytes: 16 * 1024 * 1024,
	/** Declared bytes of `SKILL.md`. */
	maxSkillMdBytes: 1024 * 1024,
	/** Bytes of one entry's `uri`. */
	maxUriBytes: 2048,
	/** Characters of a skill name. */
	maxNameChars: 64,
	/** Serialized size of one entry's frontmatter, in bytes. */
	maxFrontmatterBytes: 32 * 1024,
	/** Nesting of a frontmatter value. */
	maxFrontmatterDepth: 6,
})

/** Why an entry, or a skill name, was not taken. Stable: logged and tested by code. */
export type McpSkillRefusal =
	| 'invalid_entry'
	| 'unparseable_uri'
	| 'uri_too_long'
	| 'unshowable_uri'
	| 'placeholder_uri'
	| 'invalid_name'
	| 'name_mismatch'
	| 'invalid_frontmatter'
	| 'invalid_manifest'
	| 'too_many_resources'
	| 'too_large'
	| 'skill_md_too_large'
	| 'dynamic_declined'
	| 'duplicate_uri'
	| 'duplicate_name'
	| 'too_many_skills'
	| 'past_list_bytes'

export interface McpSkillFile {
	readonly uri: string
	/** `sha256:` and 64 lower-case hex digits. */
	readonly digest: string
	readonly size: number
}

/** An entry that passed {@link validateMcpSkillEntry}. */
export interface McpSkillEntry {
	/** The address of `SKILL.md`. */
	readonly uri: string
	/** The address without `/SKILL.md`: what every file of the skill sits under. */
	readonly root: string
	/** The last segment of {@link root}, which the frontmatter `name` equals. */
	readonly name: string
	readonly description: string
	/** The frontmatter as listed: the only copy the body is later compared with. */
	readonly frontmatter: Readonly<Record<string, unknown>>
	/** `SKILL.md`'s listed digest and size. */
	readonly digest: string
	readonly size: number
	readonly files: readonly McpSkillFile[]
}

export type McpSkillEntryVerdict =
	| { readonly ok: true; readonly entry: McpSkillEntry }
	| { readonly ok: false; readonly reason: McpSkillRefusal }

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
/** Control characters, quotes and angle brackets: text that cannot be shown or quoted safely. */
const UNSHOWABLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	/[\u0000-\u001f\u007f-\u009f"'<>\\\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length
}

function nesting(value: unknown, depth: number, limit: number): boolean {
	if (depth > limit) return false
	if (Array.isArray(value)) return value.every((item) => nesting(item, depth + 1, limit))
	if (isRecord(value)) return Object.values(value).every((item) => nesting(item, depth + 1, limit))
	return true
}

function sizeOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Check one `skills/list` entry. Accepts nothing it cannot fully explain.
 *
 * The URI must end in `/SKILL.md`, carry no `$` (placeholders use it), show
 * no characters that cannot be quoted, and survive normalisation unchanged.
 * Its last directory segment is the skill's name and the frontmatter `name`
 * must equal it. The file list must hold `SKILL.md` exactly once and only
 * files under the skill's root; `"dynamic"` is declined because there is no
 * list to check a body against.
 */
export function validateMcpSkillEntry(raw: unknown): McpSkillEntryVerdict {
	const refuse = (reason: McpSkillRefusal): McpSkillEntryVerdict => ({ ok: false, reason })
	if (!isRecord(raw)) return refuse('invalid_entry')
	const uri = raw.uri
	if (typeof uri !== 'string' || uri.length === 0) return refuse('invalid_entry')
	if (byteLength(uri) > MCP_SKILL_LIMITS.maxUriBytes) return refuse('uri_too_long')
	if (uri.includes('$')) return refuse('placeholder_uri')
	if (UNSHOWABLE.test(uri) || uri.normalize('NFKC') !== uri) return refuse('unshowable_uri')
	try {
		new URL(uri)
	} catch {
		return refuse('unparseable_uri')
	}
	const suffix = `/${MCP_SKILL_FILE}`
	if (!uri.endsWith(suffix) || uri.length === suffix.length) return refuse('invalid_entry')
	const root = uri.slice(0, -suffix.length)
	const name = root.slice(root.lastIndexOf('/') + 1)
	if (
		name.length === 0 ||
		name.length > MCP_SKILL_LIMITS.maxNameChars ||
		!NAME_PATTERN.test(name)
	) {
		return refuse('invalid_name')
	}

	const frontmatter = raw.frontmatter
	if (!isRecord(frontmatter)) return refuse('invalid_frontmatter')
	if (
		byteLength(JSON.stringify(frontmatter)) > MCP_SKILL_LIMITS.maxFrontmatterBytes ||
		!nesting(frontmatter, 0, MCP_SKILL_LIMITS.maxFrontmatterDepth)
	) {
		return refuse('invalid_frontmatter')
	}
	if (typeof frontmatter.name !== 'string' || frontmatter.name.length === 0) {
		return refuse('invalid_frontmatter')
	}
	if (typeof frontmatter.description !== 'string') return refuse('invalid_frontmatter')
	if (frontmatter.name !== name) return refuse('name_mismatch')

	const resources = raw.resources
	if (resources === 'dynamic') return refuse('dynamic_declined')
	if (!Array.isArray(resources)) return refuse('invalid_manifest')
	if (resources.length > MCP_SKILL_LIMITS.maxFiles) return refuse('too_many_resources')
	const files: McpSkillFile[] = []
	const seen = new Set<string>()
	let total = 0
	let skillMd: McpSkillFile | undefined
	for (const item of resources) {
		if (!isRecord(item)) return refuse('invalid_manifest')
		const { uri: fileUri, digest } = item
		const size = sizeOf(item.size)
		if (typeof fileUri !== 'string' || typeof digest !== 'string' || size === undefined) {
			return refuse('invalid_manifest')
		}
		if (!DIGEST_PATTERN.test(digest)) return refuse('invalid_manifest')
		if (!fileUri.startsWith(`${root}/`) || fileUri.length === root.length + 1) {
			return refuse('invalid_manifest')
		}
		if (
			fileUri
				.slice(root.length + 1)
				.split('/')
				.some((part) => part === '' || part === '..' || part === '.')
		) {
			return refuse('invalid_manifest')
		}
		if (seen.has(fileUri)) return refuse('invalid_manifest')
		seen.add(fileUri)
		total += size
		const file: McpSkillFile = { uri: fileUri, digest, size }
		files.push(file)
		if (fileUri === uri) skillMd = file
	}
	if (!skillMd) return refuse('invalid_manifest')
	if (skillMd.size > MCP_SKILL_LIMITS.maxSkillMdBytes) return refuse('skill_md_too_large')
	if (total > MCP_SKILL_LIMITS.maxTotalBytes) return refuse('too_large')

	return {
		ok: true,
		entry: {
			uri,
			root,
			name,
			description: frontmatter.description,
			frontmatter,
			digest: skillMd.digest,
			size: skillMd.size,
			files,
		},
	}
}

export interface McpSkillAdmission {
	readonly accepted: readonly McpSkillEntry[]
	/** One per entry not taken; `uri` only when the entry had a usable one. */
	readonly refused: readonly { readonly uri?: string; readonly reason: McpSkillRefusal }[]
}

/**
 * Check a whole listing: each entry, then the limits that need the rest.
 *
 * Duplicates (same URI, same name) keep the first. Entries past the listing
 * byte cap or past the skill cap are dropped, in listed order.
 */
export function admitMcpSkillEntries(listed: readonly unknown[]): McpSkillAdmission {
	const accepted: McpSkillEntry[] = []
	const refused: { uri?: string; reason: McpSkillRefusal }[] = []
	const uris = new Set<string>()
	let bytes = 0
	for (const raw of listed) {
		const uri = isRecord(raw) && typeof raw.uri === 'string' ? raw.uri.slice(0, 200) : undefined
		const note = (reason: McpSkillRefusal): void => {
			refused.push(uri === undefined ? { reason } : { uri, reason })
		}
		let size: number
		try {
			size = byteLength(JSON.stringify(raw) ?? '')
		} catch {
			note('invalid_entry')
			continue
		}
		bytes += size
		if (bytes > MCP_SKILL_LIMITS.maxListingBytes) {
			note('past_list_bytes')
			continue
		}
		const verdict = validateMcpSkillEntry(raw)
		if (!verdict.ok) {
			note(verdict.reason)
			continue
		}
		if (uris.has(verdict.entry.uri)) {
			note('duplicate_uri')
			continue
		}
		if (accepted.length >= MCP_SKILL_LIMITS.maxSkills) {
			note('too_many_skills')
			continue
		}
		uris.add(verdict.entry.uri)
		accepted.push(verdict.entry)
	}
	return { accepted, refused }
}

/**
 * Why a server's name cannot prefix skill names, or `undefined` when it can.
 *
 * The name appears in `server:skill`, in the manifest and in permission
 * rules, so it must not hold what would break those: `$`, `:`, quotes,
 * angle brackets, control or invisible characters, or text that changes
 * under normalisation.
 */
export function mcpSkillServerNameProblem(serverName: string): string | undefined {
	if (serverName.length === 0) return 'the server name is empty'
	if (/[$:]/.test(serverName)) return 'the server name holds "$" or ":"'
	if (UNSHOWABLE.test(serverName) || serverName.normalize('NFKC') !== serverName) {
		return 'the server name holds a quote, bracket, control or hidden character'
	}
	return undefined
}

/** One skill with the name the person and the model see. */
export interface McpNamedSkill {
	readonly name: string
	readonly entry: McpSkillEntry
}

/** `where the entry sits`: the path after the authority, and the authority with it. */
function qualifiers(entry: McpSkillEntry): readonly string[] {
	const rest = entry.root.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
	const slash = rest.indexOf('/')
	const authority = slash < 0 ? rest : rest.slice(0, slash)
	const path = slash < 0 ? '' : rest.slice(slash + 1)
	return [entry.name, ...(path ? [path] : []), authority && path ? `${authority}/${path}` : rest]
}

/**
 * Give each accepted entry its `server:skill` name.
 *
 * The bare name when free; on a duplicate within the server, the directory
 * path, then the authority and path, taking the first not already used. An
 * entry with no free form is refused as `duplicate_name`. A name another
 * source already holds (`taken`: other servers' skills, local skills) is
 * never taken: that entry is refused as `duplicate_name` too, so a server
 * can neither replace nor shadow anything.
 */
export function nameMcpSkills(
	serverName: string,
	entries: readonly McpSkillEntry[],
	taken: ReadonlySet<string> = new Set(),
): {
	readonly named: readonly McpNamedSkill[]
	readonly refused: readonly { readonly uri: string; readonly reason: McpSkillRefusal }[]
	/** Entries that got a qualified form because the bare name was used. */
	readonly qualified: readonly { readonly uri: string; readonly name: string }[]
} {
	const used = new Set<string>()
	const named: McpNamedSkill[] = []
	const refused: { uri: string; reason: McpSkillRefusal }[] = []
	const qualified: { uri: string; name: string }[] = []
	for (const entry of entries) {
		const forms = qualifiers(entry).map((form) => `${serverName}:${form}`)
		const pick = forms.find((form) => !used.has(form) && !taken.has(form))
		if (pick === undefined) {
			refused.push({ uri: entry.uri, reason: 'duplicate_name' })
			continue
		}
		// A taken bare name is the other source's to keep; do not slip in
		// under a longer spelling of the same skill.
		if (taken.has(forms[0] as string) && !used.has(forms[0] as string)) {
			refused.push({ uri: entry.uri, reason: 'duplicate_name' })
			continue
		}
		used.add(pick)
		named.push({ name: pick, entry })
		if (pick !== forms[0]) qualified.push({ uri: entry.uri, name: pick })
	}
	return { named, refused, qualified }
}

/** The one line that says how many skills were not loaded and why, or `undefined` when all were. */
export function summarizeMcpSkillRefusals(
	refused: readonly { readonly reason: McpSkillRefusal }[],
): string | undefined {
	if (refused.length === 0) return undefined
	const counts = new Map<McpSkillRefusal, number>()
	for (const item of refused) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
	const parts = [...counts.entries()].map(([reason, count]) => `${reason} ${count}`)
	return `${refused.length} skill${refused.length === 1 ? '' : 's'} not loaded (${parts.join(', ')})`
}
