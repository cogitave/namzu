/**
 * What a person types after `marketplace add`, and what a catalog entry says
 * its plugin's source is, read into plain values. Nothing here touches the
 * disk or the network: the parser runs first, the fetchers act on its result.
 *
 * Marketplace addresses are read in a fixed order: the scp-like ssh form
 * (`user@host:path[.git][#ref]`), then `https://`, then a local path (handled
 * by the caller, it needs the disk), then `owner/repo[#ref|@ref]` for GitHub.
 * Every ref, path and host that ends up in a command line is checked here so a
 * value can never be taken for an option.
 */

export type MarketplaceSource =
	| {
			readonly source: 'github'
			readonly repo: string
			readonly ref?: string
			readonly sparsePaths?: readonly string[]
	  }
	| {
			readonly source: 'git'
			readonly url: string
			readonly ref?: string
			readonly sparsePaths?: readonly string[]
	  }
	| { readonly source: 'url'; readonly url: string }

export type RemoteAddress =
	| {
			readonly ok: true
			readonly form: 'github' | 'git' | 'https'
			readonly source: MarketplaceSource
	  }
	| { readonly ok: false; readonly message: string }

export const NOT_AN_ADDRESS =
	'Not a marketplace address. Use owner/repo, an https:// address, or a folder path.'

const KNOWN_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org']
const SCP_FORM = /^([A-Za-z0-9_][\w.-]*)@([A-Za-z0-9][\w.-]*):([^\s\\]+)$/
const SHORTHAND = /^([\w][\w.-]*)\/([\w][\w.-]*?)(?:\.git)?(?:[#@](.+))?$/
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** A full commit id: a ref that pins and is fetched by id. */
export function isCommitId(value: string): boolean {
	return COMMIT_ID.test(value)
}

/** Why a ref may not be used, or `undefined` when it is fine. A ref never starts with a dash. */
export function refProblem(ref: string): string | undefined {
	if (
		!/^[A-Za-z0-9_][A-Za-z0-9._/+-]{0,199}$/.test(ref) ||
		ref.includes('..') ||
		ref.includes('//') ||
		ref.endsWith('/') ||
		ref.endsWith('.') ||
		ref.endsWith('.lock')
	)
		return `"${ref}" is not a branch, tag or commit name Namzu will pass to Git.`
	return undefined
}

/** Why a path inside a repository may not be used, or `undefined`. */
export function repoPathProblem(path: string): string | undefined {
	if (
		path === '' ||
		path.length > 300 ||
		path.startsWith('/') ||
		path.startsWith('-') ||
		path.startsWith('~') ||
		/^[A-Za-z]:/.test(path) ||
		path.includes('\\') ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
		/[\u0000-\u001f\u007f]/.test(path) ||
		path.split('/').some((part) => part === '..' || part === '.' || part === '')
	)
		return `"${path}" is not a folder inside the repository (no .., no absolute path).`
	return undefined
}

function splitRef(value: string): { base: string; ref?: string } {
	const at = value.indexOf('#')
	if (at < 0) return { base: value }
	return { base: value.slice(0, at), ref: value.slice(at + 1) }
}

/**
 * The remote forms, after the local-path form has been ruled out by the
 * caller. `https://` addresses with sign-in details, a query or a page inside
 * a repository are refused here too.
 */
export function parseRemoteAddress(input: string): RemoteAddress {
	const value = input.trim()
	if (value === '' || value.startsWith('-') || /\s/.test(value))
		return { ok: false, message: NOT_AN_ADDRESS }
	const scp = SCP_FORM.exec(splitRef(value).base)
	if (scp !== null) {
		const { base, ref } = splitRef(value)
		if (ref !== undefined) {
			const problem = refProblem(ref)
			if (problem !== undefined) return { ok: false, message: problem }
		}
		return {
			ok: true,
			form: 'git',
			source: { source: 'git', url: base, ...(ref !== undefined ? { ref } : {}) },
		}
	}
	if (/^https:\/\//i.test(value)) return parseHttps(value)
	const short = SHORTHAND.exec(value)
	if (short !== null && !value.includes(':')) {
		const [, owner, repo, ref] = short as unknown as [string, string, string, string | undefined]
		if (owner === '.' || owner === '..' || repo === '.' || repo === '..')
			return { ok: false, message: NOT_AN_ADDRESS }
		if (ref !== undefined) {
			const problem = refProblem(ref)
			if (problem !== undefined) return { ok: false, message: problem }
		}
		return {
			ok: true,
			form: 'github',
			source: { source: 'github', repo: `${owner}/${repo}`, ...(ref !== undefined ? { ref } : {}) },
		}
	}
	if (value.includes('/') && !value.includes(':'))
		return {
			ok: false,
			message: `'${value.slice(0, 80)}' is not a valid GitHub owner/repo shorthand. For a Git repository use its full https:// address. For a hosted marketplace.json use its https:// address. For a folder on this computer start with ./ or use an absolute path.`,
		}
	return { ok: false, message: NOT_AN_ADDRESS }
}

function parseHttps(value: string): RemoteAddress {
	const { base, ref } = splitRef(value)
	let url: URL
	try {
		url = new URL(base)
	} catch {
		return { ok: false, message: NOT_AN_ADDRESS }
	}
	if (url.username !== '' || url.password !== '' || url.search !== '')
		return {
			ok: false,
			message: 'Remove the sign-in details from the address; Namzu uses your own Git setup.',
		}
	if (ref !== undefined) {
		const problem = refProblem(ref)
		if (problem !== undefined) return { ok: false, message: problem }
	}
	const host = url.hostname.toLowerCase()
	const path = url.pathname.replace(/\/+$/, '')
	if (host === 'github.com' && /\/(tree|blob)\//.test(path))
		return {
			ok: false,
			message: 'Use the repository address (owner/repo), not a page inside it.',
		}
	const isGit = path.endsWith('.git') || path.includes('/_git/')
	const hosted = KNOWN_GIT_HOSTS.includes(host)
		? /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(path)
		: null
	if (hosted !== null && host === 'github.com')
		return {
			ok: true,
			form: 'https',
			source: {
				source: 'github',
				repo: `${hosted[1]}/${hosted[2]}`,
				...(ref !== undefined ? { ref } : {}),
			},
		}
	if (isGit || hosted !== null) {
		const clean =
			hosted !== null
				? `https://${host}/${hosted[1]}/${hosted[2]}.git`
				: `https://${host}${url.port ? `:${url.port}` : ''}${path}`
		return {
			ok: true,
			form: 'https',
			source: { source: 'git', url: clean, ...(ref !== undefined ? { ref } : {}) },
		}
	}
	if (ref !== undefined)
		return {
			ok: false,
			message: 'A hosted marketplace.json address takes no #ref: it is one file, not a repository.',
		}
	return {
		ok: true,
		form: 'https',
		source: { source: 'url', url: `https://${host}${url.port ? `:${url.port}` : ''}${path}` },
	}
}

/** The address Git is given for a marketplace source. */
export function gitUrlOf(source: Extract<MarketplaceSource, { source: 'github' | 'git' }>): string {
	return source.source === 'github' ? `https://github.com/${source.repo}.git` : source.url
}

/** How a source is named to a person. */
export function describeSource(source: {
	readonly source: string
	readonly [key: string]: unknown
}): string {
	switch (source.source) {
		case 'github':
			return `github.com/${String(source.repo)}`
		case 'git':
		case 'url':
			return String(source.url)
		default:
			return String(source.path ?? source.source)
	}
}

/** `host/path`, lowercase, no scheme and no `.git`: what a block-list entry is compared with. */
export function sourceKey(source: { readonly source: string; readonly [key: string]: unknown }):
	| string
	| undefined {
	let text: string
	if (source.source === 'github') text = `github.com/${String(source.repo)}`
	else if (source.source === 'git' || source.source === 'url') text = String(source.url)
	else return undefined
	const scp = /^[^@/]+@([^:/]+):\/?(.+)$/.exec(text)
	if (scp !== null) text = `${scp[1]}/${scp[2]}`
	return text
		.replace(/^[a-z]+:\/\//i, '')
		.replace(/\.git$/i, '')
		.replace(/\/+$/, '')
		.toLowerCase()
}

/** Whether `blocked` (entries like `acme/tools`, `github.com/acme/*`, `example.com`) names this source. */
export function isBlockedSource(
	source: { readonly source: string; readonly [key: string]: unknown },
	blocked: readonly string[] | undefined,
): boolean {
	if (blocked === undefined || blocked.length === 0) return false
	const key = sourceKey(source)
	if (key === undefined) return false
	for (const raw of blocked) {
		let entry = raw
			.trim()
			.toLowerCase()
			.replace(/^[a-z]+:\/\//, '')
			.replace(/\.git$/, '')
		if (entry === '') continue
		// `owner/repo` and `owner/*` mean GitHub.
		if (!entry.split('/')[0]?.includes('.') && !entry.includes('@')) entry = `github.com/${entry}`
		if (entry.endsWith('/*')) {
			if (key.startsWith(entry.slice(0, -1))) return true
		} else if (!entry.includes('/')) {
			if (key === entry || key.startsWith(`${entry}/`)) return true
		} else if (key === entry.replace(/\/+$/, '')) return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Plugin entry sources
// ---------------------------------------------------------------------------

export type RemoteEntrySource =
	| { readonly kind: 'github'; readonly repo: string; readonly ref?: string; readonly sha?: string }
	| { readonly kind: 'git'; readonly url: string; readonly ref?: string; readonly sha?: string }
	| {
			readonly kind: 'git-subdir'
			readonly url: string
			readonly path: string
			readonly ref?: string
			readonly sha?: string
	  }
	| { readonly kind: 'archive'; readonly url: string; readonly sha256?: string }

export type EntrySourceRead =
	| { readonly ok: true; readonly source: RemoteEntrySource }
	| { readonly ok: false; readonly unsupported: boolean; readonly reason: string }

const SHA256 = /^[0-9a-f]{64}$/i

/** Why a git address (not a person's typing: a catalog's) may not be used, or `undefined`. */
export function gitUrlProblem(url: string, allowFile: boolean): string | undefined {
	if (url.startsWith('-') || /\s/.test(url)) return 'it is not a Git address'
	if (SCP_FORM.test(url)) return undefined
	if (/^https:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			return 'it is not a Git address'
		}
		if (parsed.password !== '' || (parsed.protocol === 'https:' && parsed.username !== ''))
			return 'it has sign-in details in it'
		if (parsed.hostname === '' || parsed.hostname.startsWith('-')) return 'it names no host'
		return undefined
	}
	if (allowFile && (url.startsWith('/') || /^file:\/\//i.test(url))) return undefined
	return 'only https and ssh addresses are accepted'
}

/** Read a catalog entry's `source` mapping into a source Namzu can fetch, or the reason it cannot. */
export function parseEntrySource(
	name: string,
	source: Readonly<Record<string, unknown>>,
	entry: Readonly<Record<string, unknown>>,
	allowFile = false,
): EntrySourceRead {
	const kind = typeof source.source === 'string' ? source.source : ''
	const invalid = (reason: string): EntrySourceRead => ({ ok: false, unsupported: false, reason })
	const text = (value: unknown): string | undefined =>
		typeof value === 'string' && value !== '' ? value : undefined
	if (kind === 'npm' || kind === 'command' || kind === '')
		return {
			ok: false,
			unsupported: true,
			reason: `${name} is obtained by ${kind === '' ? 'an unknown means' : kind}, which Namzu does not install: it would run a package manager or another program to get the code.`,
		}
	if (
		kind !== 'github' &&
		kind !== 'url' &&
		kind !== 'git' &&
		kind !== 'git-subdir' &&
		kind !== 'archive'
	)
		return {
			ok: false,
			unsupported: true,
			reason: `${name} is obtained by ${kind}, which Namzu does not install.`,
		}
	if (
		'headers' in entry ||
		'headersHelper' in entry ||
		'headers' in source ||
		'headersHelper' in source
	)
		return {
			ok: false,
			unsupported: true,
			reason: `${name} needs request headers or a helper program to download, which Namzu does not run.`,
		}
	const ref = text(source.ref)
	const sha = text(source.sha)
	if (ref !== undefined) {
		const problem = refProblem(ref)
		if (problem !== undefined) return invalid(`${name}: ${problem}`)
	}
	if (sha !== undefined && !isCommitId(sha.toLowerCase()))
		return invalid(`${name}: the sha pin must be a full 40 or 64 character commit id.`)
	const pins = {
		...(ref !== undefined ? { ref } : {}),
		...(sha !== undefined ? { sha: sha.toLowerCase() } : {}),
	}
	if (kind === 'github') {
		const repo = text(source.repo)
		if (repo === undefined || !/^[\w][\w.-]*\/[\w][\w.-]*$/.test(repo))
			return invalid(`${name}: the GitHub source needs repo as owner/repo.`)
		return { ok: true, source: { kind: 'github', repo, ...pins } }
	}
	if (kind === 'archive') {
		const url = text(source.url)
		if (url === undefined || !/^https:\/\//i.test(url))
			return invalid(`${name}: an archive must be downloaded over https.`)
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			return invalid(`${name}: the archive address is not an address.`)
		}
		if (parsed.username !== '' || parsed.password !== '')
			return invalid(`${name}: remove the sign-in details from the archive address.`)
		const sha256 = text(source.sha256)
		if (sha256 !== undefined && !SHA256.test(sha256))
			return invalid(`${name}: sha256 must be 64 hexadecimal characters.`)
		return {
			ok: true,
			source: {
				kind: 'archive',
				url,
				...(sha256 !== undefined ? { sha256: sha256.toLowerCase() } : {}),
			},
		}
	}
	const url = text(source.url)
	if (url === undefined) return invalid(`${name}: the source has no url.`)
	const problem = gitUrlProblem(url, allowFile)
	if (problem !== undefined) return invalid(`${name}: ${problem}.`)
	if (kind === 'url') return { ok: true, source: { kind: 'git', url, ...pins } }
	const path = text(source.path)
	if (path === undefined) return invalid(`${name}: a git-subdir source needs a path.`)
	const pathProblem = repoPathProblem(path)
	if (pathProblem !== undefined) return invalid(`${name}: ${pathProblem}`)
	return { ok: true, source: { kind: 'git-subdir', url, path, ...pins } }
}
