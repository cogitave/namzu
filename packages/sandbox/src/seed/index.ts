/**
 * Sandbox seeds: git repositories a host wants present inside a sandbox,
 * prepared by an idempotent step the caller runs, and prepared once on storage
 * that outlives the sandbox (a kubernetes workspace's disk, a docker scratch
 * bind the host reuses).
 *
 * The idea is ax's workspace repositories, prepared once with a marker on a
 * durable disk; the code is this package's own. It is level-triggered in the
 * sense that matters: every call looks at what is there and does only what is
 * missing, so running it after every create or resume is the intended use.
 *
 * Everything runs through `Sandbox.exec`, so a file-root jail on the backend
 * does not matter, and the guest needs `sh`, `git`, `find`, `mkdir`, `mktemp`,
 * `rm` and a `mv` that takes `-T` (GNU coreutils; checked by a probe, not by
 * name).
 *
 * WHAT IS TRUSTED, AND WHAT IS NOT. The seed marker lives in guest-writable
 * storage, so an agent can forge it. It is never the reason a repository is
 * skipped: every call checks each repository directly (it exists, its origin is
 * the seed's URL, and the pinned or recorded commit is an ancestor of its
 * HEAD), and the marker only remembers which commit a `ref` resolved to, and
 * under which `ref`. A marker value that is not a commit id is ignored rather
 * than passed to git.
 *
 * A CHANGED `ref` IS NOT THE SAME SEED. The recorded commit is used only when
 * it was recorded under what the seed names now: the same `ref`, the default
 * branch for none, or a pin (a pin's record never stands in for a `ref` or the
 * default branch once the pin is dropped). Otherwise the check looks in the
 * repository itself: the ref must exist there (as a remote-tracking branch or
 * a tag; `refs/remotes/origin/HEAD` for the default branch) and name exactly
 * HEAD. Sharing a line of history with HEAD is not enough, because the ref is
 * often there without having been checked out: a clone deeper than 1 carries
 * the tags in its history, and a pinned commit's full clone carries every
 * remote branch. So a checkout of another branch, tag or commit is drift like
 * any other, and a seed whose `ref` moved never reports the old checkout as
 * `present`. The cost is on the safe side: with no record under the ref, local
 * commits on top of it, or a `--branch` clone whose `ref` is then dropped
 * (such a clone has no `origin/HEAD`), are drift too. A digest match is never
 * a reason to skip a check either.
 *
 * NO CREDENTIAL ENTERS THE GUEST. URLs with a user name or password, `ssh://`
 * and `git@host:path` are refused, since each would put a secret or a private
 * key inside the sandbox. `https://` is for public repositories. `http://` is
 * for one documented path: on the docker backend the egress proxy upgrades a
 * plain request to HTTPS and stamps `brokeredCredentials` for the host, so a
 * private repository can be cloned with no token in the guest. On every other
 * backend private repositories are out of scope.
 *
 * NOTHING IS EVER DELETED OR RE-CLONED BUT THIS CALL'S OWN WORK. A repository
 * whose origin or history no longer matches is drift: refused by default, or
 * reported. A clone lands in `<dir>.namzu-partial-<nonce>` and is moved into
 * place with `mv -T`, so two hosts preparing the same disk never see each
 * other's half-written clone; the loser of that race removes only its own
 * partial. Partials older than an hour, which only a crashed call leaves, are
 * removed at the end, after this call's own clones have finished, so a peer's
 * clone that is still running is left alone.
 */

import { createHash, randomBytes } from 'node:crypto'

import type { Sandbox, SandboxExecResult } from '@namzu/sdk'

/** One repository of a {@link SandboxSeed}. */
export interface SandboxSeedRepository {
	/** A DNS-1123 label, unique in the seed. The default directory under the seed root. */
	readonly name: string
	/**
	 * `https://` for a public repository, or `http://` for a host the docker
	 * egress proxy brokers a credential for (see the module doc). No user name
	 * or password, no `ssh://`, no `git@host:path`.
	 */
	readonly url: string
	/**
	 * A branch or tag. Resolved once, when cloned, and the commit recorded with
	 * the ref. Changing it later is drift unless HEAD on disk is exactly the
	 * commit the new ref names in the repository (see the module doc).
	 */
	readonly ref?: string
	/** A full commit id to pin. Wins over `ref`, and is checked on every call. */
	readonly commit?: string
	/**
	 * Directory relative to the seed root. Default `name`. No `..`, not
	 * absolute, not under `.namzu/` (the marker's directory), and neither
	 * inside nor containing another repository's directory.
	 */
	readonly dir?: string
	/**
	 * Clone depth. Default 1. Refused together with `commit`, because a pinned
	 * commit is fetched with its history so it can be checked out and later
	 * proved an ancestor of HEAD.
	 */
	readonly depth?: number
}

/** A named set of repositories. */
export interface SandboxSeed {
	/** A DNS-1123 label. Names the marker file under `<root>/.namzu/seed/`. */
	readonly name: string
	readonly repositories: readonly SandboxSeedRepository[]
}

/** What one repository was found or left as. */
export interface SandboxSeedRepositoryReport {
	readonly name: string
	/**
	 * `cloned` by this call; `present` and matching the seed; `drifted`, its
	 * origin, `ref` or history no longer matching, reported under
	 * `onDrift: 'report'` and left exactly as it was.
	 */
	readonly status: 'cloned' | 'present' | 'drifted'
	/** The repository's HEAD commit. */
	readonly commit: string
}

/** What {@link ensureSandboxSeed} found and did. */
export interface SandboxSeedReport {
	/** {@link sandboxSeedDigest} of the seed. */
	readonly digest: string
	readonly repositories: readonly SandboxSeedRepositoryReport[]
}

/** Options for {@link ensureSandboxSeed}. */
export interface EnsureSandboxSeedOptions {
	/**
	 * Absolute directory inside the sandbox the repositories go under.
	 * Required, because the right place depends on the backend: on docker the
	 * sandbox's working root is the outputs bind the host collects, so a
	 * default there would put repositories in the user's outputs. Use the
	 * kubernetes workspace template's disk mount, or `layout.scratch` on docker.
	 */
	readonly root: string
	/** Cancels the call; handed to every `exec`. */
	readonly signal?: AbortSignal
	/**
	 * Per-`exec` timeout in milliseconds, handed to the backend. A clone of a
	 * large repository needs one sized for it; unset leaves the backend's own.
	 */
	readonly timeoutMs?: number
	/** `'refuse'` (the default) throws on drift before cloning anything; `'report'` records it. */
	readonly onDrift?: 'refuse' | 'report'
}

/** Why a seed could not be prepared. */
export type SandboxSeedErrorCode = 'invalid' | 'tool-missing' | 'clone-failed' | 'drift'

/** A seed refused, or a step that failed. `repository` names the repository when there is one. */
export class SandboxSeedError extends Error {
	override readonly name = 'SandboxSeedError'

	constructor(
		readonly code: SandboxSeedErrorCode,
		message: string,
		readonly repository?: string,
	) {
		super(`sandbox seed: ${message}`)
	}
}

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

/** The check's drift states, and what each says about the repository. */
const DRIFT_STATES: ReadonlyMap<string, string> = new Map([
	['origin', 'has a different origin URL'],
	['history', 'no longer contains its pinned or recorded commit'],
	[
		'ref',
		"does not hold the seed's ref (the default branch when it names none): with no record under that ref, HEAD must be exactly the commit the ref names in the repository, and it is another branch, tag or commit",
	],
	[
		'pin',
		'is not checked out at its pinned commit: with no record of that pin, HEAD must be exactly the pinned commit, and it is another commit',
	],
	['occupied', 'is a directory that is not a git repository'],
])

/**
 * What CHECK looks up for a seed that names no `ref` and has no record: the
 * remote's default branch, as `refs/remotes/origin/HEAD` (which a clone with
 * no `--branch` leaves). It starts with ':', which no `ref` the seed accepts
 * can, so it never collides with a branch or tag name.
 */
const DEFAULT_BRANCH = ':default'

/**
 * The marker's `refs` entry for a repository: what its recorded commit was
 * resolved from. A pinned repository records `:commit`, so dropping the pin
 * never lets the pinned commit stand in for the default branch or a `ref`.
 */
function recordedFrom(repo: SandboxSeedRepository): string {
	return repo.commit !== undefined ? ':commit' : (repo.ref ?? '')
}

/** How old a partial clone must be before a later call removes it. */
const STALE_PARTIAL_MINUTES = 60

function refuseUrl(url: unknown, where: string): string {
	if (typeof url !== 'string' || url.length === 0) {
		throw new SandboxSeedError('invalid', `${where} is not a URL`)
	}
	if (/^[^/]*@[^/]*:/.test(url) && !url.includes('://')) {
		throw new SandboxSeedError(
			'invalid',
			`${where} is an scp-style SSH address; SSH would need a private key inside the sandbox, so only https:// (and http:// for a proxy-brokered host) is accepted`,
		)
	}
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new SandboxSeedError('invalid', `${where} is not a URL`)
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new SandboxSeedError(
			'invalid',
			`${where} uses ${parsed.protocol.replace(/:$/, '')}; only https:// (and http:// for a proxy-brokered host) is accepted, because other transports would need a credential or a key inside the sandbox`,
		)
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new SandboxSeedError(
			'invalid',
			`${where} carries a user name or password, which would put a credential inside the sandbox; on docker, broker it with brokeredCredentials and an http:// URL instead`,
		)
	}
	if (/\s/.test(url)) throw new SandboxSeedError('invalid', `${where} contains whitespace`)
	return url
}

function refuseDir(dir: string, where: string): string {
	const segments = dir.split('/')
	if (
		dir.startsWith('/') ||
		segments.some((segment) => segment === '..' || segment === '.' || !PATH_SEGMENT.test(segment))
	) {
		throw new SandboxSeedError(
			'invalid',
			`${where} ${JSON.stringify(dir)} must be a relative path of plain segments (letters, digits, '.', '_', '-'), with no '..'`,
		)
	}
	if (segments[0] === '.namzu' || segments.some((segment) => segment.includes('.namzu-partial-'))) {
		throw new SandboxSeedError(
			'invalid',
			`${where} ${JSON.stringify(dir)} is reserved: .namzu/ holds the seed marker, and '.namzu-partial-' names a clone in progress`,
		)
	}
	return dir
}

/**
 * Validate a seed and return it frozen. Refused with `SandboxSeedError`
 * (`code: 'invalid'`): a name that is not a DNS-1123 label, no repositories,
 * a repository name repeated, a URL outside the rules in the module doc, a
 * `ref` that is not a plain branch or tag name, a `commit` that is not a full
 * commit id, a `dir` that is absolute, climbs or is under `.namzu/`, two
 * repositories in one directory or one inside the other, and `depth` that is not a positive integer or is set beside
 * `commit`.
 */
export function defineSandboxSeed(input: SandboxSeed): SandboxSeed {
	if (typeof input?.name !== 'string' || !DNS_1123_LABEL.test(input.name)) {
		throw new SandboxSeedError(
			'invalid',
			`name ${JSON.stringify(input?.name)} is not a DNS-1123 label`,
		)
	}
	if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
		throw new SandboxSeedError('invalid', 'repositories must list at least one repository')
	}
	const names = new Set<string>()
	const dirs: string[] = []
	const repositories = input.repositories.map((repo, index): SandboxSeedRepository => {
		const where = `repositories[${index}]`
		if (typeof repo?.name !== 'string' || !DNS_1123_LABEL.test(repo.name)) {
			throw new SandboxSeedError(
				'invalid',
				`${where}.name ${JSON.stringify(repo?.name)} is not a DNS-1123 label`,
			)
		}
		if (names.has(repo.name)) {
			throw new SandboxSeedError(
				'invalid',
				`${where}.name ${JSON.stringify(repo.name)} is listed twice`,
			)
		}
		names.add(repo.name)
		const url = refuseUrl(repo.url, `${where}.url`)
		if (
			repo.ref !== undefined &&
			(typeof repo.ref !== 'string' || !REF.test(repo.ref) || repo.ref.includes('..'))
		) {
			throw new SandboxSeedError(
				'invalid',
				`${where}.ref ${JSON.stringify(repo.ref)} is not a branch or tag name`,
			)
		}
		if (
			repo.commit !== undefined &&
			(typeof repo.commit !== 'string' || !COMMIT_ID.test(repo.commit))
		) {
			throw new SandboxSeedError(
				'invalid',
				`${where}.commit ${JSON.stringify(repo.commit)} is not a full lowercase commit id`,
			)
		}
		if (repo.depth !== undefined) {
			if (!Number.isInteger(repo.depth) || repo.depth < 1) {
				throw new SandboxSeedError(
					'invalid',
					`${where}.depth ${JSON.stringify(repo.depth)} is not a positive integer`,
				)
			}
			if (repo.commit !== undefined) {
				throw new SandboxSeedError(
					'invalid',
					`${where}.depth is set beside commit; a pinned commit is fetched with its history`,
				)
			}
		}
		const dir = refuseDir(repo.dir ?? repo.name, `${where}.dir`)
		if (dirs.includes(dir)) {
			throw new SandboxSeedError(
				'invalid',
				`${where}.dir ${JSON.stringify(dir)} is used by another repository`,
			)
		}
		// A clone creates its parent directories, so a repository inside
		// another's directory would occupy it before that one is cloned.
		const nested = dirs.find((other) => other.startsWith(`${dir}/`) || dir.startsWith(`${other}/`))
		if (nested !== undefined) {
			throw new SandboxSeedError(
				'invalid',
				`${where}.dir ${JSON.stringify(dir)} and ${JSON.stringify(nested)} are nested; each repository needs a directory of its own, neither inside the other`,
			)
		}
		dirs.push(dir)
		return Object.freeze({
			name: repo.name,
			url,
			...(repo.ref !== undefined ? { ref: repo.ref } : {}),
			...(repo.commit !== undefined ? { commit: repo.commit } : {}),
			...(repo.dir !== undefined ? { dir: repo.dir } : {}),
			...(repo.depth !== undefined ? { depth: repo.depth } : {}),
		})
	})
	return Object.freeze({ name: input.name, repositories: Object.freeze(repositories) })
}

/**
 * A stable digest of the seed's content: SHA-256 over its normalised form,
 * hex. Two seeds with the same repositories in the same order have the same
 * digest whatever key order they were written in.
 */
export function sandboxSeedDigest(seed: SandboxSeed): string {
	const defined = defineSandboxSeed(seed)
	const canonical = {
		name: defined.name,
		repositories: defined.repositories.map((repo) => [
			repo.name,
			repo.url,
			repo.ref ?? null,
			repo.commit ?? null,
			repo.dir ?? repo.name,
			repo.depth ?? null,
		]),
	}
	return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

type Exec = (script: string, args: readonly string[]) => Promise<SandboxExecResult>

function tail(text: string): string {
	const trimmed = text.trim()
	return trimmed.length > 800 ? `…${trimmed.slice(-800)}` : trimmed
}

const PREFLIGHT = `
for tool in git find mkdir mktemp rm; do
	command -v "$tool" >/dev/null 2>&1 || { printf 'missing %s\\n' "$tool"; exit 3; }
done
mkdir -p "$1/.namzu/seed" || { printf 'unwritable %s\\n' "$1"; exit 4; }
probe=$(mktemp -d "$1/.namzu/seed/probe.XXXXXX") || { printf 'unwritable %s\\n' "$1"; exit 4; }
mkdir "$probe/a"
if mv -T "$probe/a" "$probe/b" 2>/dev/null; then ok=1; else ok=0; fi
rm -rf "$probe"
[ "$ok" = 1 ] || { printf 'missing mv -T\\n'; exit 3; }
`

// Arguments, per repository: dir, url, expected commit ('' for none), ref to
// find in the repository when there is no expected commit ('' for none,
// DEFAULT_BRANCH for the remote's default branch), and '1' when the expected
// commit is a pin the marker has no record of, which HEAD must then equal
// exactly (the ancestor rule holds only for a pin this call recorded). A ref found that way must
// be exactly HEAD: sharing a line of history with HEAD is not holding it, since
// a clone deeper than 1 carries the tags in its history and a pinned commit's
// full clone carries every remote branch. Prints '<state> <head>', and for
// 'present' the commit it held HEAD to ('-' for none).
const CHECK = `
while [ "$#" -ge 5 ]; do
	dir=$1; url=$2; want=$3; ref=$4; exact=$5; shift 5
	if [ ! -e "$dir" ]; then printf 'missing -\\n'; continue; fi
	if [ ! -e "$dir/.git" ]; then printf 'occupied -\\n'; continue; fi
	origin=$(git -C "$dir" config --get remote.origin.url 2>/dev/null || true)
	head=$(git -C "$dir" rev-parse --verify --quiet HEAD 2>/dev/null || printf -- '-')
	if [ "$origin" != "$url" ]; then printf 'origin %s\\n' "$head"; continue; fi
	if [ -z "$want" ] && [ -n "$ref" ]; then
		if [ "$ref" = "${DEFAULT_BRANCH}" ]; then
			tip=$(git -C "$dir" rev-parse --verify --quiet "refs/remotes/origin/HEAD^{commit}" 2>/dev/null || true)
		else
			tip=$(git -C "$dir" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" 2>/dev/null ||
				git -C "$dir" rev-parse --verify --quiet "refs/tags/$ref^{commit}" 2>/dev/null || true)
		fi
		if [ -z "$tip" ] || [ "$tip" != "$head" ]; then printf 'ref %s\\n' "$head"; continue; fi
		want=$tip
	elif [ -n "$want" ] && [ "$exact" = 1 ]; then
		if [ "$want" != "$head" ]; then printf 'pin %s\\n' "$head"; continue; fi
	elif [ -n "$want" ] && ! git -C "$dir" merge-base --is-ancestor "$want" HEAD 2>/dev/null; then
		printf 'history %s\\n' "$head"; continue
	fi
	printf 'present %s %s\\n' "$head" "\${want:--}"
done
`

// Arguments: dir, url, ref ('' for default), commit ('' for none), depth ('' for full), nonce.
const CLONE = `
set -e
dir=$1; url=$2; ref=$3; commit=$4; depth=$5; nonce=$6
mkdir -p "$(dirname "$dir")"
partial="$dir.namzu-partial-$nonce"
set -- clone --quiet
[ -n "$depth" ] && set -- "$@" --depth "$depth"
[ -n "$ref" ] && set -- "$@" --branch "$ref"
git -c credential.helper= "$@" -- "$url" "$partial"
if [ -n "$commit" ]; then git -C "$partial" -c advice.detachedHead=false checkout --quiet --detach "$commit"; fi
head=$(git -C "$partial" rev-parse HEAD)
if mv -T "$partial" "$dir" 2>/dev/null; then printf 'cloned %s\\n' "$head"; else rm -rf -- "$partial"; printf 'raced %s\\n' "$head"; fi
`

// Arguments: marker path, content, this call's nonce, then the parent
// directories to sweep. The temporary name carries the nonce, not the shell's
// PID: two sandboxes sharing one disk often run this as the same PID, each in
// its own PID namespace.
const FINISH = `
set -e
marker=$1; content=$2; nonce=$3; shift 3
tmp="$marker.tmp.$nonce"
if ! { printf '%s' "$content" > "$tmp" && mv -f -- "$tmp" "$marker"; }; then
	rm -f -- "$tmp"
	exit 1
fi
for parent in "$@"; do
	[ -d "$parent" ] || continue
	find "$parent" -mindepth 1 -maxdepth 1 -type d -name '*.namzu-partial-*' -mmin +${STALE_PARTIAL_MINUTES} -exec rm -rf -- {} + 2>/dev/null || true
done
`

interface Marker {
	readonly commits: Readonly<Record<string, string>>
	/** What each commit was resolved from: the `ref`, `''` for the default branch, `:commit` for a pin. */
	readonly refs: Readonly<Record<string, string>>
}

/**
 * The recorded commit of each repository whose record was made under the ref
 * the seed names now. A record made under another ref says nothing about this
 * one, so it is dropped and the repository is checked against the ref itself.
 */
function readMarker(raw: string, seed: SandboxSeed): Map<string, string> {
	const commits = new Map<string, string>()
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return commits
	}
	const recorded = (parsed as Partial<Marker> | null)?.commits
	const refs = (parsed as Partial<Marker> | null)?.refs
	if (recorded === null || typeof recorded !== 'object') return commits
	if (refs === null || typeof refs !== 'object') return commits
	for (const repo of seed.repositories) {
		const value = (recorded as Record<string, unknown>)[repo.name]
		const ref = (refs as Record<string, unknown>)[repo.name]
		if (ref !== recordedFrom(repo)) continue
		// Guest-writable: a value that is not a commit id is ignored rather
		// than handed to git, where it could be read as an option.
		if (typeof value === 'string' && COMMIT_ID.test(value)) commits.set(repo.name, value)
	}
	return commits
}

/**
 * The ref CHECK looks for in the repository: none when a commit is pinned or
 * recorded, otherwise the seed's `ref` or, with none, the default branch.
 */
function refToFind(repo: SandboxSeedRepository, want: string): string {
	return want === '' ? (repo.ref ?? DEFAULT_BRANCH) : ''
}

function joinPath(root: string, dir: string): string {
	return `${root.replace(/\/+$/, '')}/${dir}`
}

function parentOf(path: string): string {
	return path.slice(0, path.lastIndexOf('/')) || '/'
}

/**
 * Make the seed's repositories present under `options.root`, doing only what
 * is missing, and report what was found. See the module doc for what is
 * trusted, what is refused and what is never deleted.
 */
export async function ensureSandboxSeed(
	sandbox: Sandbox,
	seed: SandboxSeed,
	options: EnsureSandboxSeedOptions,
): Promise<SandboxSeedReport> {
	const defined = defineSandboxSeed(seed)
	const root = options?.root
	if (
		typeof root !== 'string' ||
		!root.startsWith('/') ||
		root.split('/').includes('..') ||
		/\s/.test(root)
	) {
		throw new SandboxSeedError(
			'invalid',
			`root ${JSON.stringify(root)} must be an absolute path inside the sandbox with no '..' and no whitespace; it is required because the right place depends on the backend (a kubernetes workspace's disk mount, layout.scratch on docker)`,
		)
	}
	const onDrift = options.onDrift ?? 'refuse'
	const digest = sandboxSeedDigest(defined)
	const markerPath = joinPath(root, `.namzu/seed/${defined.name}.json`)

	const exec: Exec = async (script, args) => {
		options.signal?.throwIfAborted()
		return await sandbox.exec('sh', ['-c', script, 'namzu-seed', ...args], {
			env: { GIT_TERMINAL_PROMPT: '0' },
			...(options.signal !== undefined ? { signal: options.signal } : {}),
			...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		})
	}

	// 1. The tools, by probe. A guest with no `sh` at all fails the exec itself.
	let preflight: SandboxExecResult
	try {
		preflight = await exec(PREFLIGHT, [root])
	} catch (error) {
		options.signal?.throwIfAborted()
		throw new SandboxSeedError(
			'tool-missing',
			`could not run sh in the sandbox (${error instanceof Error ? error.message : String(error)}); the image needs sh, git, find, mkdir, mktemp, rm and GNU mv`,
		)
	}
	if (preflight.exitCode !== 0) {
		const line = preflight.stdout.trim()
		const missing = line.startsWith('missing ') ? line.slice('missing '.length) : undefined
		if (missing !== undefined || preflight.exitCode === 127) {
			throw new SandboxSeedError(
				'tool-missing',
				`the sandbox image has no ${missing ?? 'sh'}; it needs sh, git, find, mkdir, mktemp, rm and a mv that takes -T (GNU coreutils)`,
			)
		}
		throw new SandboxSeedError(
			'invalid',
			`root ${JSON.stringify(root)} is not writable in the sandbox: ${tail(preflight.stdout + preflight.stderr)}`,
		)
	}

	// 2. What is there. The marker is read for the commits refs resolved to, and
	//    only for those; every repository is then checked directly.
	const markerRead = await exec('cat -- "$1" 2>/dev/null || true', [markerPath])
	const recorded = readMarker(markerRead.stdout, defined)
	const paths = defined.repositories.map((repo) => joinPath(root, repo.dir ?? repo.name))
	const expected = defined.repositories.map((repo) => repo.commit ?? recorded.get(repo.name) ?? '')
	const checkArgs: string[] = []
	defined.repositories.forEach((repo, index) => {
		const want = expected[index] as string
		const unrecordedPin = repo.commit !== undefined && recorded.get(repo.name) !== repo.commit
		checkArgs.push(
			paths[index] as string,
			repo.url,
			want,
			refToFind(repo, want),
			unrecordedPin ? '1' : '',
		)
	})
	const checked = await exec(CHECK, checkArgs)
	if (checked.exitCode !== 0) {
		throw new SandboxSeedError(
			'invalid',
			`could not inspect the seed root: ${tail(checked.stderr)}`,
		)
	}
	const lines = checked.stdout.trim().split('\n')
	const states = defined.repositories.map((repo, index) => {
		const [state, head, held] = (lines[index] ?? '').split(' ')
		if (!DRIFT_STATES.has(state ?? '') && state !== 'missing' && state !== 'present') {
			throw new SandboxSeedError('invalid', `unreadable check result for ${repo.name}`, repo.name)
		}
		return { state, head: head ?? '-', held: held !== undefined && held !== '-' ? held : undefined }
	})

	// 3. Drift is refused before anything is cloned, so a refusal leaves the
	//    root exactly as it was found.
	const drifted = defined.repositories.filter((_, index) =>
		DRIFT_STATES.has(states[index]?.state ?? ''),
	)
	if (drifted.length > 0 && onDrift === 'refuse') {
		throw new SandboxSeedError(
			'drift',
			`${drifted
				.map((repo) => {
					const state = states[defined.repositories.indexOf(repo)]?.state ?? ''
					return `${repo.name} ${DRIFT_STATES.get(state)}`
				})
				.join('; ')}. Nothing was changed; resolve it by hand, or pass onDrift: 'report'`,
			drifted[0]?.name,
		)
	}

	// 4. Clone what is missing, each into its own partial directory.
	const reports: SandboxSeedRepositoryReport[] = []
	const commits: Record<string, string> = {}
	const refs: Record<string, string> = {}
	const record = (repo: SandboxSeedRepository, commit: string): void => {
		commits[repo.name] = commit
		refs[repo.name] = recordedFrom(repo)
	}
	for (const [index, repo] of defined.repositories.entries()) {
		const state = states[index] as { state: string; head: string; held: string | undefined }
		const path = paths[index] as string
		if (state.state === 'present') {
			reports.push({ name: repo.name, status: 'present', commit: state.head })
			record(repo, state.held ?? state.head)
			continue
		}
		if (DRIFT_STATES.has(state.state)) {
			reports.push({ name: repo.name, status: 'drifted', commit: state.head })
			const known = recorded.get(repo.name)
			if (known !== undefined) record(repo, known)
			continue
		}
		const nonce = randomBytes(6).toString('hex')
		const depth = repo.commit !== undefined ? '' : String(repo.depth ?? 1)
		const cloned = await exec(CLONE, [
			path,
			repo.url,
			repo.ref ?? '',
			repo.commit ?? '',
			depth,
			nonce,
		])
		const [outcome, head] = cloned.stdout.trim().split('\n').at(-1)?.split(' ') ?? []
		if (
			cloned.exitCode !== 0 ||
			(outcome !== 'cloned' && outcome !== 'raced') ||
			head === undefined
		) {
			throw new SandboxSeedError(
				'clone-failed',
				`cloning ${repo.name} from ${repo.url} failed (exit ${cloned.exitCode}${cloned.timedOut ? ', timed out' : ''}): ${tail(cloned.stderr)}`,
				repo.name,
			)
		}
		if (outcome === 'cloned') {
			reports.push({ name: repo.name, status: 'cloned', commit: head })
			record(repo, repo.commit ?? head)
			continue
		}
		// Something took the directory while this call cloned: a peer moved
		// its clone into place first. Ours is gone; check what is there the
		// same way any present repository is checked, and say what it is.
		const want = repo.commit ?? ''
		const recheck = await exec(CHECK, [
			path,
			repo.url,
			want,
			refToFind(repo, want),
			repo.commit !== undefined ? '1' : '',
		])
		const [again, peerHead, held] = recheck.stdout.trim().split(' ')
		if (again !== 'present') {
			const what = DRIFT_STATES.get(again ?? '') ?? 'could not be checked'
			if (onDrift === 'refuse') {
				throw new SandboxSeedError(
					'drift',
					`${repo.name} appeared while this call was cloning it, and ${what}. This call's own clone was removed; nothing else was changed`,
					repo.name,
				)
			}
			reports.push({ name: repo.name, status: 'drifted', commit: peerHead ?? '-' })
			continue
		}
		reports.push({ name: repo.name, status: 'present', commit: peerHead ?? '-' })
		record(repo, repo.commit ?? (held !== undefined && held !== '-' ? held : (peerHead ?? head)))
	}

	// 5. The marker, written whole and moved into place; then stale partials.
	const content = JSON.stringify({ seed: defined.name, digest, commits, refs })
	const parents = [...new Set(paths.map(parentOf))]
	const finishNonce = randomBytes(6).toString('hex')
	const finished = await exec(FINISH, [markerPath, content, finishNonce, ...parents])
	if (finished.exitCode !== 0) {
		throw new SandboxSeedError(
			'invalid',
			`could not write the seed marker: ${tail(finished.stderr)}`,
		)
	}
	return { digest, repositories: reports }
}
