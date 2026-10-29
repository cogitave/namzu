/**
 * The workflow files `namzu github install` writes.
 *
 * Two are offered. One answers a request that names `@namzu` in an issue or
 * pull request comment; the other reviews a pull request when it is opened.
 * Both run `namzu exec` on the runner and post what it printed as a comment,
 * with the repository not pushable by the run and a dollar limit on the spend.
 *
 * The files are plain text with the choices filled in; nothing here reads a
 * credential, calls a host or runs a command.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type WorkflowId = 'mention' | 'review'

export const WORKFLOW_IDS: readonly WorkflowId[] = ['mention', 'review']

export interface WorkflowChoices {
	/** The repository secret that holds the provider key. */
	readonly secret: string
	/** The environment variable the provider reads its key from. */
	readonly envVar: string
	readonly provider: string
	readonly model?: string
	readonly budgetUsd: number
	/** The CLI release line the runner installs, such as `42`. */
	readonly cliMajor: string
}

interface WorkflowSpec {
	readonly id: WorkflowId
	readonly file: string
	readonly label: string
	readonly render: (choices: WorkflowChoices) => string
}

/** The line every run starts with: the same flags in both files. */
function execFlags(choices: WorkflowChoices): string {
	return [
		'namzu exec --trust',
		`--provider ${choices.provider}`,
		...(choices.model ? [`--model ${choices.model}`] : []),
		`--max-budget-usd ${choices.budgetUsd}`,
		'--disallowed-tools "edit write"',
	].join(' ')
}

const MENTION_INSTRUCTION =
	'You are answering a request made in a comment on this repository. The request follows. Read the code you need, answer it directly, and keep the reply short enough to read in a comment.'

const REVIEW_INSTRUCTION =
	'Review pull request $PR_NUMBER in this repository. Read the change with gh pr diff $PR_NUMBER and open the files it touches. Report correctness bugs, risky changes and missing tests, each with the file and line. Say so plainly when you find none.'

const SPECS: readonly WorkflowSpec[] = [
	{
		id: 'mention',
		file: 'namzu.yml',
		label: 'Answer @namzu mentions in issues and pull request comments',
		render: (choices) => `name: Namzu

# Runs when a repository owner, member or collaborator writes @namzu in an
# issue, a pull request or a review comment. The run can read the repository
# and cannot push to it; the answer is posted back as a comment.
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened]

jobs:
  namzu:
    if: |
      contains(github.event.comment.body || github.event.issue.body, '@namzu') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association || github.event.issue.author_association)
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --global @namzu/cli@${choices.cliMajor}
      - name: Answer
        env:
          ${choices.envVar}: \${{ secrets.${choices.secret} }}
          GH_TOKEN: \${{ github.token }}
          REQUEST: \${{ github.event.comment.body || github.event.issue.body }}
          NUMBER: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          printf '%s\\n\\n%s\\n' ${shellQuote(MENTION_INSTRUCTION)} "$REQUEST" \\
            | ${execFlags(choices)} > reply.md
          gh issue comment "$NUMBER" --body-file reply.md
`,
	},
	{
		id: 'review',
		file: 'namzu-review.yml',
		label: 'Review each new pull request',
		render: (choices) => `name: Namzu review

# Runs when a pull request from this repository is opened or marked ready.
# The run can read the repository and cannot push to it; the review is posted
# as a comment. A pull request from a fork gets no run, since the repository
# secret is not shared with forks.
on:
  pull_request:
    types: [opened, ready_for_review]

jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --global @namzu/cli@${choices.cliMajor}
      - name: Review
        env:
          ${choices.envVar}: \${{ secrets.${choices.secret} }}
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          ${execFlags(choices)} ${shellQuote(REVIEW_INSTRUCTION)} > review.md
          gh pr comment "$PR_NUMBER" --body-file review.md
`,
	},
]

/** Single-quote a fixed sentence for a shell line; `$VAR` inside it is left to the shell on purpose only where wanted. */
function shellQuote(text: string): string {
	// The review sentence names $PR_NUMBER, so it is double-quoted; the mention
	// sentence has no variable and is single-quoted.
	if (text.includes('$PR_NUMBER')) return `"${text.replace(/"/g, '\\"')}"`
	return `'${text.replace(/'/g, `'\\''`)}'`
}

export function workflowSpec(id: WorkflowId): WorkflowSpec {
	const spec = SPECS.find((entry) => entry.id === id)
	if (!spec) throw new Error(`unknown workflow ${id}`)
	return spec
}

export function workflowFile(id: WorkflowId): string {
	return workflowSpec(id).file
}

export function workflowLabel(id: WorkflowId): string {
	return workflowSpec(id).label
}

export function renderWorkflow(id: WorkflowId, choices: WorkflowChoices): string {
	return workflowSpec(id).render(choices)
}

/** The nearest folder at or above `from` that holds a `.git` entry, or `null`. */
export function repositoryRoot(from: string): string | null {
	let dir = resolve(from)
	for (;;) {
		if (existsSync(join(dir, '.git'))) return dir
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

export interface WrittenWorkflow {
	readonly id: WorkflowId
	/** Path relative to the repository root, with forward slashes. */
	readonly path: string
	readonly status: 'written' | 'replaced' | 'kept'
}

/**
 * Write the chosen workflows under `.github/workflows`. A file that already
 * exists is left alone unless `force` is set.
 */
export function writeWorkflows(
	root: string,
	ids: readonly WorkflowId[],
	choices: WorkflowChoices,
	force: boolean,
): WrittenWorkflow[] {
	const out: WrittenWorkflow[] = []
	for (const id of ids) {
		const relative = `.github/workflows/${workflowFile(id)}`
		const target = join(root, '.github', 'workflows', workflowFile(id))
		const exists = existsSync(target) && statSync(target).isFile()
		if (exists && !force) {
			out.push({ id, path: relative, status: 'kept' })
			continue
		}
		mkdirSync(dirname(target), { recursive: true })
		writeFileSync(target, renderWorkflow(id, choices), 'utf8')
		out.push({ id, path: relative, status: exists ? 'replaced' : 'written' })
	}
	return out
}
