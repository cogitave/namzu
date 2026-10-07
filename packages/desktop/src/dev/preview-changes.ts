import type { ProjectChangeFile, ProjectChangesView, ProjectDiffView } from '../shared/protocol.js'

/** A git-like working tree for the design preview: every status the review view distinguishes. */
const lines = (count: number, make: (index: number) => string) =>
	Array.from({ length: count }, (_, index) => make(index + 1)).join('\n')

const design = (version: string) =>
	`# Security report design\n\n## Objective\n\nCreate an English, IT-facing security posture report that explains what is implemented.\n\n## Evidence policy\n\n${lines(
		6,
		(index) => `${index}. Cite a stable repository-relative path for claim ${index}${version}.`,
	)}\n\n## Review plan\n\n- Cross-check the draft for unsupported claims.\n- Run the documentation gate after each edit.\n`

type Entry = {
	file: ProjectChangeFile
	before: string | null
	after: string | null
	binary?: boolean
}

const entries: Entry[] = [
	{
		file: {
			path: '.work/sessions/ses_102/design.md',
			status: 'added',
			added: 18,
			removed: 0,
		},
		before: null,
		after: design(''),
	},
	{
		file: {
			path: '.work/sessions/ses_102/progress.md',
			status: 'untracked',
			added: 4,
			removed: 0,
		},
		before: null,
		after: '# Progress\n\n- Drafted the evidence policy.\n- Waiting for the review pass.\n',
	},
	{
		file: { path: 'docs/README.md', status: 'modified', added: 3, removed: 2 },
		before:
			'# Docs\n\nStart with the overview.\n\nThe guide is out of date.\nSee the old page.\n\nMore soon.\n',
		after:
			'# Docs\n\nStart with the overview.\n\nThe guide now covers review.\nSee the security report.\nSee the changelog.\n\nMore soon.\n',
	},
	{
		file: {
			path: 'docs/security-report.md',
			status: 'modified',
			added: 9,
			removed: 1,
		},
		before: `# Security report\n\n${lines(12, (index) => `Line ${index} of the report.`)}\n`,
		after: `# Security report\n\n${lines(12, (index) => (index === 6 ? 'Line 6 was reworded.' : `Line ${index} of the report.`))}\n\n## Appendix\n\n${lines(
			8,
			(index) => `- Appendix item ${index}`,
		)}\n`,
	},
	{
		file: {
			path: 'src/shell/old-name.ts',
			oldPath: 'src/shell/legacy.ts',
			status: 'renamed',
			added: 1,
			removed: 1,
		},
		before: "export const shell = 'legacy'\nexport const kind = 'a'\n",
		after: "export const shell = 'current'\nexport const kind = 'a'\n",
	},
	{
		file: {
			path: 'src/shell/unused.ts',
			status: 'deleted',
			added: 0,
			removed: 3,
		},
		before: 'export function unused() {\n  return 1\n}\n',
		after: null,
	},
	{
		// Past the rich-diff size gate, so the review shows a plain patch first.
		file: { path: 'src/generated/rate-table.ts', status: 'modified', added: 5000, removed: 5000 },
		before: `${lines(5000, (index) => `export const rate${index} = ${index * 3}`)}\n`,
		after: `${lines(5000, (index) => `export const rate${index} = ${index * 7}`)}\n`,
	},
	{
		file: { path: 'assets/logo.png', status: 'binary', added: 0, removed: 0 },
		before: null,
		after: null,
		binary: true,
	},
]

export function sampleWorkingTree(): ProjectChangesView {
	return {
		files: entries.map((entry) => ({ ...entry.file })),
		truncated: false,
	}
}

export function sampleWorkingDiff(path: string): ProjectDiffView {
	const entry = entries.find((item) => item.file.path === path)
	if (!entry) throw new Error('That file has no changes.')
	return {
		before: entry.before,
		after: entry.after,
		binary: entry.binary === true,
		truncated: false,
	}
}

/** The text of each uncommitted file that still exists, so opening one in a tab finds it. */
export function sampleWorkingFiles(): Record<string, string> {
	return Object.fromEntries(
		entries.flatMap((entry) =>
			entry.after === null || entry.binary ? [] : [[entry.file.path, entry.after] as const],
		),
	)
}
