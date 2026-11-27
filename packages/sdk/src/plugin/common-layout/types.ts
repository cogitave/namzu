import type { PluginManifest, PluginRemoteMCPServerConfig } from '../../types/plugin/index.js'
import type { PluginPathValues } from './paths.js'

/**
 * How a finding about a plugin read through the common layout weighs.
 *
 * - `used`: a component Namzu reads and uses.
 * - `ignored`: harmless metadata or a key nothing here reads; shown in details only.
 * - `notUsed`: a feature Namzu has no place for; the plugin still loads.
 * - `refused`: dropped. At entry level (one server, one skill, one hooks file)
 *   the plugin loads without it; at plugin level the plugin does not load.
 */
export type LayoutFindingLevel = 'used' | 'ignored' | 'notUsed' | 'refused'

export interface LayoutFinding {
	readonly level: LayoutFindingLevel
	/** A stable kebab-case code, the same for the same cause. */
	readonly code: string
	/** The manifest field or folder the finding is about. */
	readonly field: string
	readonly message: string
	/** The file inside the plugin the finding is about, when it names one. */
	readonly path?: string
	/**
	 * Set on a `mcp-needs-setup` finding: which tool server it is about and
	 * whether that server starts a program (`local`) or is reached over the
	 * network (`remote`), so a host can list a remote server that is not usable
	 * yet without parsing the message.
	 */
	readonly server?: { readonly name: string; readonly kind: 'local' | 'remote' }
}

/** Where the manifest of a read came from. */
export type CommonLayoutSource =
	| 'namzu'
	| 'manifest'
	| 'sidecar'
	| 'single-skill'
	| 'conventional'
	| 'none'

export interface CommonLayoutOptions {
	/**
	 * Read the install sidecar when it is there. Set only by a caller that holds
	 * an install record naming this folder: a hand-placed folder and a repository
	 * never reach this, so neither can inject components through it.
	 */
	readonly entrySidecar?: boolean
	/** Folders the path names stand for besides the plugin's own, by plugin name. */
	readonly paths?: (name: string) => Omit<PluginPathValues, 'root'>
	/** The environment `${VAR}` in a server's `env` is read from. Default `process.env`. */
	readonly environment?: Readonly<Record<string, string | undefined>>
	/** Ids (`name` or `name@marketplace`) already installed, for `dependencies`. Default none. */
	readonly installedIds?: ReadonlySet<string>
	/** A version to use when the manifest names none (the entry's, a commit, a digest). */
	readonly version?: string
	/** A description to use when neither the manifest nor `README.md` gives one. */
	readonly description?: string
}

export interface CommonLayoutRead {
	readonly source: CommonLayoutSource
	/** The manifest to admit; absent when the plugin is refused or is a Namzu `plugin.json`. */
	readonly manifest?: PluginManifest
	readonly remoteServers: readonly PluginRemoteMCPServerConfig[]
	readonly findings: readonly LayoutFinding[]
	/** Set when the whole plugin is refused: the finding that says why. */
	readonly refusal?: LayoutFinding
}
