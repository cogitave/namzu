import type {
	ProjectFileContent,
	ProjectFileEntry,
	ProjectLinkResolution,
} from '../shared/protocol.js'

/** An in-memory project for the design preview: Markdown with frontmatter, source, an image and a large file. */
type SampleFile =
	| { kind: 'text'; text: string }
	| { kind: 'image'; image: string; size: number }
	| { kind: 'binary'; size: number }
	| { kind: 'too-large'; size: number }

const diagram = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="560" height="220"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="560" height="220" rx="14" fill="url(#g)"/><rect x="28" y="28" width="150" height="164" rx="10" fill="rgba(255,255,255,.35)"/><rect x="198" y="28" width="334" height="34" rx="8" fill="rgba(255,255,255,.55)"/><rect x="198" y="78" width="334" height="114" rx="10" fill="rgba(255,255,255,.25)"/></svg>',
)}`

const designSystem = `---
uid: sample.app.design-system
title: Sample design system, the two surface systems
description: The binding design standard for the sample app. The shell (clean UI) and data (table) surface systems, their token tiers, the values they are locked to, and the gates that must clear before a build ships.
type: reference
owner: sample/design
resource: design/tokens
tags: [design, tokens, "surface systems"]
reviewed: 2026-07-28
---

# Sample design system, the two surface systems

> This is the standard for this product, not a suggestion sheet.
> Every surface styles itself only from the tokens in [design/tokens.json](../design/tokens.json).

The app renders two kinds of screen and they are tuned differently on purpose:

| System | Where it applies | Face | Character |
| --- | --- | --- | --- |
| shell | the rail, the header, page titles, buttons, list rows | Inter, served from here | tight tracking, five type sizes, 32px rows |
| data | tables, ledgers, dense lists | the system face | tabular figures, 28px rows, no decoration |

## Tokens

1. A literal colour, size or font name in component code is a review failure.
2. Hover and focus come from [the sidebar rules](../src/sidebar.css) and [the rail](../src/rail.css).
3. The next step is in [the phase 1 plan](./2026-07-28-phase-1-plan.md); see also [the decision record](decisions/adr-1.md#context).

![The two surfaces side by side](../assets/diagram.png)

## Checks

- [x] Focus ring is visible on every control
- [ ] Contrast is checked in both themes
- [ ] The data surface stays at 28px rows

\`\`\`css
.row:hover {
  background: var(--accent);
}
\`\`\`

An outside reference lives at [the WAI guidance](https://example.test/rich).
`

const phasePlan = `---
title: Phase 1 plan
status: draft
---

# Phase 1 plan

Ship the rail and the header first, then the data surface. Back to [the design system](./2026-07-28-design-system.md).
`

const sample: Record<string, SampleFile> = {
	'README.md': {
		kind: 'text',
		text: '# Sample app\n\nA small project for the design preview.\n\n- Read [the design system](docs/2026-07-28-design-system.md).\n- Start with `src/renderer/app.tsx`.\n',
	},
	'package.json': {
		kind: 'text',
		text: '{\n  "name": "sample-app",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
	},
	'docs/2026-07-28-design-system.md': { kind: 'text', text: designSystem },
	'docs/2026-07-28-phase-1-plan.md': { kind: 'text', text: phasePlan },
	'docs/2026-07-28-session-briefs.md': { kind: 'text', text: '# Session briefs\n\nNothing yet.\n' },
	'docs/2026-07-30-nothing-hardcoded.md': {
		kind: 'text',
		text: '---\ntitle: Nothing hardcoded\n---\n\n# Nothing hardcoded\n\nEvery value is a token.\n',
	},
	'docs/decisions/adr-1.md': {
		kind: 'text',
		text: '# ADR 1\n\n## Context\n\nTwo surfaces, one token set.\n',
	},
	'docs/research/notes.md': { kind: 'text', text: '# Notes\n\nTo read later.\n' },
	'assets/diagram.png': { kind: 'image', image: diagram, size: 18_400 },
	'assets/archive.bin': { kind: 'binary', size: 40_960 },
	'design/tokens.json': {
		kind: 'text',
		text: '{\n  "ring": "#6366f1",\n  "hover": "#f4f4f5"\n}\n',
	},
	'src/sidebar.css': {
		kind: 'text',
		text: '.row {\n  padding: 6px;\n  gap: 6px;\n  border-radius: 8px;\n}\n.row:hover {\n  background: var(--accent);\n}\n',
	},
	'src/rail.css': {
		kind: 'text',
		text: '.rail a {\n  color: inherit;\n}\n.rail a:hover {\n  background: var(--accent);\n}\n',
	},
	'src/components/header.tsx': {
		kind: 'text',
		text: 'export const Header = () => (\n  <header className="focus-ring">\n    <nav />\n  </header>\n)\n',
	},
	'src/renderer/app.tsx': {
		kind: 'text',
		text: `${Array.from({ length: 60 }, (_, index) => `// line ${index + 1}`).join('\n')}\nexport function App() {\n  return <main />\n}\n`,
	},
	'logs/build.log': { kind: 'too-large', size: 9_400_000 },
	// Past 5,000 lines the source view switches to the virtualised code view.
	'src/generated/long.ts': {
		kind: 'text',
		text: Array.from(
			{ length: 6000 },
			(_, index) => `export const line${index + 1} = ${index + 1}`,
		).join('\n'),
	},
}

const roots: Record<string, Record<string, SampleFile>> = {
	'sample-app': sample,
	'sample-docs': {
		'README.md': { kind: 'text', text: '# Sample docs\n\nThe quick start lives here.\n' },
	},
}

const tree = (projectId: string) => roots[projectId] ?? {}

function checkPath(path: string): void {
	if (path.startsWith('/') || path.split('/').includes('..'))
		throw new Error('That path is outside this project.')
}

export function listSampleDirectory(projectId: string, dir: string): ProjectFileEntry[] {
	checkPath(dir)
	const prefix = dir ? `${dir}/` : ''
	const folders = new Set<string>()
	const files: ProjectFileEntry[] = []
	for (const path of Object.keys(tree(projectId))) {
		if (!path.startsWith(prefix)) continue
		const rest = path.slice(prefix.length)
		const slash = rest.indexOf('/')
		if (slash < 0) files.push({ name: rest, path, kind: 'file' })
		else folders.add(rest.slice(0, slash))
	}
	const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
	return [
		...[...folders]
			.sort(natural)
			.map((name) => ({ name, path: `${prefix}${name}`, kind: 'directory' as const })),
		...files.sort((a, b) => natural(a.name, b.name)),
	]
}

export function sampleFileIndex(projectId: string): { paths: string[]; truncated: boolean } {
	return { paths: Object.keys(tree(projectId)).sort(), truncated: false }
}

export function readSampleFile(projectId: string, path: string): ProjectFileContent {
	checkPath(path)
	const file = tree(projectId)[path]
	if (!file) throw new Error('That file does not exist.')
	if (file.kind === 'text') {
		const content: ProjectFileContent = {
			path,
			size: file.text.length,
			kind: 'text',
			text: file.text,
		}
		if (/\.md$/i.test(path)) {
			const match = /^---\n([\s\S]*?)\n---\n?/.exec(file.text)
			if (match) {
				content.frontmatter = (match[1] ?? '')
					.split('\n')
					.filter((line) => /^[A-Za-z_]+:/.test(line))
					.map((line) => {
						const colon = line.indexOf(':')
						return { key: line.slice(0, colon), value: line.slice(colon + 1).trim() }
					})
				content.markdown = file.text.slice(match[0].length)
			} else content.markdown = file.text
		}
		return content
	}
	if (file.kind === 'image') return { path, size: file.size, kind: 'image', image: file.image }
	return { path, size: file.size, kind: file.kind }
}

export function resolveSampleLinks(projectId: string, refs: string[]): ProjectLinkResolution[] {
	const files = tree(projectId)
	return refs.map((ref) => {
		const match = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(ref)
		const path = (match?.[1] ?? ref).replace(/^\.\//, '')
		const line = Number(match?.[2] ?? match?.[3])
		return files[path]
			? { ref, path, ...(Number.isFinite(line) && line > 0 ? { line } : {}) }
			: { ref }
	})
}
