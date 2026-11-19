import type { ManifestIssue } from './types.js'
/**
 * `namzu-extension.json`, parsed strictly. The structure follows
 * `schemas/extension-1.json` (an unknown key is an error, only `x-` keys are free, a reserved key is
 * refused); `crossRules` adds what a schema cannot say. Nothing here imports anything of an extension.
 */

export const MANIFEST_MAX_BYTES = 256 * 1024
export const MAX_DEPTH = 12

export const TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
/** A reverse-DNS name: three or more dot-separated labels of lowercase letters, digits and inner hyphens. */
export const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){2,}$/
export const ID_REFUSAL =
	"is not a valid extension id: write the reverse DNS name of the publisher's domain followed by the extension name, in lowercase letters, digits and hyphens, at least three parts separated by dots, for example com.example.activity"
export const SEMVER = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/
export const NOTICE_VERSION = /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/
export const RANGE = /^[<>=~^0-9. |x*-]+$/
export const PACKAGE_PATH =
	/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
export const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const DATA_ID = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,3}$/
export const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,31}$/
export const KEY_ID = /^[a-z0-9][a-z0-9-]{2,39}$/
export const SHA256 = /^[0-9a-f]{64}$/
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
export const ENV_VALUE = /^(?:[^$]|\$\{(?:extensionDir|dataDir|id|version|locale)\})*$/
export const X_PERMISSION = /^x-[a-z0-9][a-z0-9.-]{1,60}$/

export const PLATFORMS = [
	'win32-x64',
	'win32-arm64',
	'darwin-x64',
	'darwin-arm64',
	'linux-x64',
	'linux-arm64',
] as const

export const PHASE1_PERMISSIONS = [
	'os.foregroundWindow',
	'os.lastInputTime',
	'os.sessionEvents',
	'os.inputCounts',
	'os.screenChange',
] as const

export const RESERVED_PERMISSIONS = [
	'os.windowTitle',
	'os.browserDomain',
	'os.pointerDevices',
	'host.decide',
	'host.distill',
	'host.memory',
	'tools.agent',
	'network.hosts',
	'model.call',
]
export const NEVER_PERMISSIONS = [
	'os.keyContent',
	'os.screenshot',
	'os.clipboard',
	'os.microphone',
	'os.camera',
	'os.location',
]

export const BAD_FIELD =
	/^(key|keys?code|vk|scan ?code|char|chars|typed|text|title|windowTitle|url|uri|path|file|fileName|clipboard|x|y|posX|posY|position|screenshot|image|pixels?|grid|frame|device(Id|Path)|serial|user(name)?)$/i
export const SECRETY = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

/** Top-level keys a later phase will use: refused now, by name. */
export const RESERVED_TOP = ['modelAccess', 'policy', 'managed', 'analysis']
export const RESERVED_CONTRIBUTES = ['toolServers', 'skills', 'hooks', 'panels', 'plugin']

export type Rec = Record<string, unknown>

export class Walk {
	readonly issues: ManifestIssue[] = []
	add(path: string, message: string, rule = 'schema'): void {
		this.issues.push({ rule, path, message })
	}
	/** Records an issue and answers false, so a check can `return this.no(...)`. */
	no(path: string, message: string): false {
		this.add(path, message)
		return false
	}
	isObj(path: string, v: unknown): v is Rec {
		if (v && typeof v === 'object' && !Array.isArray(v)) return true
		this.add(path, 'must be an object')
		return false
	}
	/** Required and optional keys; anything else is an error unless it starts with `x-`. */
	keys(
		path: string,
		o: Rec,
		required: readonly string[],
		optional: readonly string[] = [],
		reserved: readonly string[] = [],
	): void {
		for (const k of required)
			if (o[k] === undefined) this.add(path ? `${path}.${k}` : k, 'is required')
		for (const k of Object.keys(o)) {
			if (required.includes(k) || optional.includes(k) || k.startsWith('x-')) continue
			if (reserved.includes(k))
				this.add(
					path ? `${path}.${k}` : k,
					'is reserved for a later phase and is refused in phase 1',
				)
			else
				this.add(
					path ? `${path}.${k}` : k,
					'is not a known key (only keys starting with x- are free)',
				)
		}
	}
	str(path: string, v: unknown, re?: RegExp, min = 0, max = 100000): v is string {
		if (typeof v !== 'string') return this.no(path, 'must be a string')
		if (v.length < min || v.length > max)
			return this.no(path, `must be ${min} to ${max} characters`)
		if (re && !re.test(v)) return this.no(path, `has the wrong form: ${v.slice(0, 60)}`)
		return true
	}
	int(path: string, v: unknown, min: number, max: number): v is number {
		if (!Number.isInteger(v) || (v as number) < min || (v as number) > max)
			return this.no(path, `must be a whole number from ${min} to ${max}`)
		return true
	}
	arr(path: string, v: unknown, min = 0, max = 1000): v is unknown[] {
		if (!Array.isArray(v)) return this.no(path, 'must be a list')
		if (v.length < min || v.length > max) return this.no(path, `must have ${min} to ${max} items`)
		return true
	}
	/** Plain words keyed by locale tag. The default locale is checked by rule L2, not here. */
	text(path: string, v: unknown, min: number, max: number): void {
		if (!this.isObj(path, v)) return
		const ks = Object.keys(v)
		if (ks.length === 0) {
			this.add(path, 'needs at least one language')
			return
		}
		for (const k of ks) {
			if (!TAG.test(k) || k.length > 35) this.add(path, `bad locale tag ${k}`)
			else this.str(`${path}.${k}`, v[k], undefined, min, max)
		}
	}
	command(path: string, v: unknown): void {
		if (!this.isObj(path, v)) return
		const ks = Object.keys(v)
		if (ks.length === 0) this.add(path, 'needs a command for at least one platform')
		for (const k of ks) {
			if (!(PLATFORMS as readonly string[]).includes(k)) {
				this.add(`${path}.${k}`, 'is not a known platform')
				continue
			}
			const c = v[k]
			if (!this.isObj(`${path}.${k}`, c)) continue
			this.keys(`${path}.${k}`, c, ['exe'], ['args'])
			this.str(`${path}.${k}.exe`, c.exe, PACKAGE_PATH, 1, 200)
			if (c.args !== undefined && this.arr(`${path}.${k}.args`, c.args, 0, 15))
				c.args.forEach((a, i) => {
					if (this.str(`${path}.${k}.args[${i}]`, a, undefined, 1, 200) && a.includes('\u0000'))
						this.add(`${path}.${k}.args[${i}]`, 'must not contain NUL')
				})
		}
	}
}
