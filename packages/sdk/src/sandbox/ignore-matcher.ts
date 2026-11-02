import { IGNORE_SOURCE } from './ignore-source.js'

/** One compiled ignore rule. */
export interface IgnoreRule {
	readonly negate: boolean
	readonly dirOnly: boolean
	readonly re: RegExp
}

/** Layered ignore rules for one depth-first walk; see `ignore-source.ts`. */
export interface IgnoreStack {
	/** Find the enclosing repository and load the layers above the walk root. */
	init(root: string): Promise<void>
	/** Load a directory's rule files; call before reading it. */
	enter(directory: string): Promise<void>
	/** Drop the layer of the directory most recently entered. */
	leave(): void
	isIgnored(absolute: string, isDirectory: boolean): boolean
}

export interface IgnoreDeps {
	readonly fs: unknown
	readonly path: unknown
	/** Global exclude files, lowest precedence. The guest has none. */
	readonly extraFiles?: readonly string[]
}

interface IgnoreModule {
	parse(text: string): IgnoreRule[]
	decide(rules: readonly IgnoreRule[], relative: string, isDirectory: boolean): 0 | 1 | 2
	create(deps: IgnoreDeps): IgnoreStack
	vcs: readonly string[]
}

// The same text is embedded in the guest program, so both walks share it.
const module_ = new Function(
	`${IGNORE_SOURCE}\nreturn { parse: ignParse, decide: ignDecide, create: ignCreate, vcs: IGN_VCS }`,
)() as IgnoreModule

/** Parse the text of one ignore file into rules; a line it cannot read is dropped. */
export const parseIgnoreRules = module_.parse
/** 0: no rule matches, 1: ignored, 2: re-included. The last matching rule wins. */
export const decideIgnore = module_.decide
export const createIgnoreStack = module_.create
/** Version-control directories that no walk ever descends into. */
export const VCS_NAMES: ReadonlySet<string> = new Set(module_.vcs)
