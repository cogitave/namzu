/** Which kind of file a changed path is, for "Separate test, build, and generated files". */
export type FileKind = 'source' | 'test' | 'build' | 'generated'

export const KIND_ORDER: readonly FileKind[] = ['source', 'test', 'build', 'generated']
export const KIND_HEADING: Record<Exclude<FileKind, 'source'>, string> = {
	test: 'Test files',
	build: 'Build files',
	generated: 'Generated files',
}

const LOCKFILES = new Set([
	'package-lock.json',
	'npm-shrinkwrap.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	'bun.lock',
	'bun.lockb',
	'Cargo.lock',
	'Gemfile.lock',
	'Podfile.lock',
	'composer.lock',
	'poetry.lock',
	'uv.lock',
	'Pipfile.lock',
	'go.sum',
	'flake.lock',
	'pubspec.lock',
	'mix.lock',
	'packages.lock.json',
])

const GENERATED = [
	/(^|\/)(__generated__|generated|gen)\//,
	/[._]gen(erated)?\.[^/]+$/,
	/\.pb\.(go|h|cc|ts|js)$/,
	/_pb2(_grpc)?\.pyi?$/,
	/_pb\.(d\.ts|js|ts)$/,
	/\.g\.dart$/,
	/\.Designer\.cs$/,
	/\.min\.(js|css)$/,
	/\.(js|css)\.map$/,
	/(^|\/)(\.next|\.nuxt|\.svelte-kit|\.parcel-cache|__pycache__)\//,
	/\.pyc$/,
	/\.tsbuildinfo$/,
	/^dist\//,
]
const BUILD = [/(^|\/)(BUILD|BUILD\.bazel|WORKSPACE|MODULE\.bazel|MODULE\.bazel\.lock)$/, /\.bzl$/]
const TEST = [
	/(^|\/)(__tests__|__snapshots__)\//,
	/[._](test|spec)\.[^/]+$/,
	/(^|\/)test_[^/]*\.py$/,
	/\.snap$/,
	/\.stories\.[jt]sx?$/,
	/(^|\/)conftest\.py$/,
	/Tests?\.(swift|kt|java)$/,
	/_unittest\.(cc|cpp)$/,
	/(^|\/)tests\.rs$/,
	/(^|\/)(tests?|testdata|spec|__Snapshots__|e2e(-tests)?)\//,
	/(^|\/)[^/]*-tests\//,
]

/** A path matching several kinds takes the first of generated, build, test; otherwise it is source. */
export function fileKind(path: string): FileKind {
	const name = path.split('/').pop() ?? path
	if (LOCKFILES.has(name) || GENERATED.some((rule) => rule.test(path))) return 'generated'
	if (BUILD.some((rule) => rule.test(path))) return 'build'
	if (TEST.some((rule) => rule.test(path))) return 'test'
	return 'source'
}

export interface KindGroup<T> {
	kind: FileKind
	/** Absent for source files, which carry no heading. */
	heading?: string
	files: T[]
}

/** The files in the order the stack shows them; split by kind when asked, keeping each group's order. */
export function groupByKind<T extends { path: string }>(
	files: readonly T[],
	separate: boolean,
): KindGroup<T>[] {
	if (!separate) return [{ kind: 'source', files: [...files] }]
	return KIND_ORDER.flatMap((kind) => {
		const own = files.filter((file) => fileKind(file.path) === kind)
		if (own.length === 0) return []
		return [{ kind, ...(kind === 'source' ? {} : { heading: KIND_HEADING[kind] }), files: own }]
	})
}
