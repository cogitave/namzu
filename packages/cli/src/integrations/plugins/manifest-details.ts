import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_MANIFEST_FILENAME, parsePluginManifestText, resolveWithinReal } from '@namzu/sdk'
import { parseSkillMarkdown } from '../../skills/store.js'

/** What a plugin's manifest says about what it brings, for the Customize page. */
export interface PluginManifestDetails {
	/** The skills it ships, by the name they are typed with (`<plugin>__<skill>`). */
	readonly skills?: readonly { readonly name: string; readonly description: string }[]
	readonly servers?: readonly { readonly name: string }[]
	readonly author?: string
	/** The manifest file's modification time, in ISO form. */
	readonly updatedAt?: string
}

const MAX_DETAIL_ITEMS = 100
const NAME_MAX = 200
const DESCRIPTION_MAX = 1_024

/**
 * Reads the manifest and each shipped skill's `SKILL.md` inside the plugin folder. Nothing runs: no
 * module is imported and no server is started. A file that cannot be read leaves that part out.
 */
export async function readPluginManifestDetails(rootDir: string): Promise<PluginManifestDetails> {
	const file = join(rootDir, PLUGIN_MANIFEST_FILENAME)
	let manifest: ReturnType<typeof parsePluginManifestText>
	let updatedAt: string | undefined
	try {
		manifest = parsePluginManifestText(await readFile(file, 'utf8'))
		updatedAt = (await stat(file)).mtime.toISOString()
	} catch {
		return {}
	}
	const skills: { name: string; description: string }[] = []
	for (const path of (manifest.skills ?? []).slice(0, MAX_DETAIL_ITEMS)) {
		try {
			const folder = await resolveWithinReal(rootDir, path)
			const parsed = parseSkillMarkdown(
				await readFile(join(folder, 'SKILL.md'), 'utf8'),
				join(folder, 'SKILL.md'),
			)
			const name = parsed.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
			skills.push({
				name: `${manifest.name}__${name}`.slice(0, NAME_MAX),
				description: (parsed.description ?? '').slice(0, DESCRIPTION_MAX),
			})
		} catch {
			// A skill whose file cannot be read is left out of the list.
		}
	}
	const servers = (manifest.mcpServers ?? [])
		.slice(0, MAX_DETAIL_ITEMS)
		.map((server) => ({ name: server.name.slice(0, NAME_MAX) }))
	return {
		...(skills.length > 0 ? { skills } : {}),
		...(servers.length > 0 ? { servers } : {}),
		...(manifest.author ? { author: manifest.author.slice(0, NAME_MAX) } : {}),
		...(updatedAt ? { updatedAt } : {}),
	}
}
