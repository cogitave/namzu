import { describe, expect, it } from 'vitest'

import { groupFields, mergeGroupRows } from './group-rows.js'
import {
	EMPTY_GROUP,
	type GroupState,
	type VcsAction,
	foldOp,
	groupText,
	vcsActions,
} from './read-search-group.js'
import type { TranscriptMessage } from './types.js'

const none: VcsAction[] = []

/** [command line, the actions it counts] */
const TABLE: ReadonlyArray<readonly [string, readonly VcsAction[]]> = [
	// commits
	['git commit -m "fix the parser"', ['commit']],
	['git commit -am "wip"', ['commit']],
	['git commit --amend --no-edit', ['amend']],
	['git commit --amend -m "better words"', ['amend']],
	['git commit --am --no-edit', ['amend']],
	['git -C packages/cli commit -m x', ['commit']],
	['git -c user.name=a -c user.email=b commit -m x', ['commit']],
	['git --no-pager commit -m x', ['commit']],
	['GIT_AUTHOR_NAME=a git commit -m x', ['commit']],
	['GIT_AUTHOR_NAME="a b" git commit -m x', ['commit']],
	['git commit -m "push the button"', ['commit']],
	['git commit -m "run git push next"', ['commit']],
	['git commit -m "use --amend later"', ['commit']],
	['git commit -S -m x', ['commit']],
	['git commit --fixup HEAD~1', ['commit']],
	['git commit --dry-run', none],
	['git commit -h', none],
	['git commit --help', none],
	// pushes
	['git push', ['push']],
	['git push origin main', ['push']],
	['git push -u origin feature/x', ['push']],
	['git push --force-with-lease origin main', ['push']],
	['git push --tags', ['push']],
	['git push --dry-run', none],
	['git push -n origin main', none],
	['git push origin --delete old', none],
	['git push -o ci.skip origin main', ['push']],
	['git push origin $BRANCH', none],
	// branches
	['git switch main', ['switch-branch']],
	['git switch -', ['switch-branch']],
	['git switch -c topic', ['create-branch']],
	['git switch --create topic origin/main', ['create-branch']],
	['git switch --detach HEAD~2', none],
	['git checkout -b topic', ['create-branch']],
	['git checkout -B topic origin/main', ['create-branch']],
	['git checkout main', none],
	['git checkout -- src/a.ts', none],
	['git branch topic', ['create-branch']],
	['git branch topic origin/main', ['create-branch']],
	['git branch', none],
	['git branch -a', none],
	['git branch -d topic', none],
	['git branch --show-current', none],
	// merges and rebases
	['git merge topic', ['merge']],
	['git merge --no-ff topic', ['merge']],
	['git merge -m "bring it in" topic', ['merge']],
	['git merge --abort', none],
	['git rebase origin/main', ['rebase']],
	['git rebase --onto main old topic', ['rebase']],
	['git rebase --continue', none],
	['git rebase --abort', none],
	// pull requests
	['gh pr create --title "x" --body "y"', ['pr-open']],
	['gh pr create --fill', ['pr-open']],
	['gh pr create --web', none],
	['gh pr create --dry-run', none],
	['gh pr merge 12 --squash', ['pr-merge']],
	['gh pr merge --auto --squash', none],
	['gh pr view 12', none],
	['gh pr list', none],
	['gh pr checkout 12', none],
	['gh pr status', none],
	['gh issue create --title x', none],
	['gh api repos/x/y', none],
	['gh auth status', none],
	// reads that must not count
	['git status', none],
	['git status --short', none],
	['git log --oneline -5', none],
	['git diff', none],
	['git diff --stat main...HEAD', none],
	['git show HEAD', none],
	['git fetch origin', none],
	['git add -A', none],
	['git stash', none],
	['git remote -v', none],
	// compounds
	['git add -A && git commit -m x', ['commit']],
	['git add -A && git commit -m x && git push', ['commit', 'push']],
	['git commit -m a && git commit -m b', ['commit', 'commit']],
	['cd packages/cli && git commit -m x', ['commit']],
	[
		'git switch -c t && git push -u origin t && gh pr create --fill',
		['create-branch', 'push', 'pr-open'],
	],
	['git add . && git status', none],
	// not sure, so not counted
	['git ci -m x', none],
	['git cm', none],
	['git "commit" -m x', none],
	['"git" commit -m x', none],
	['g\\it commit -m x', none],
	['git -c alias.commit=status commit', none],
	['git $SUB -m x', none],
	['git commit $FLAGS', none],
	['git commit -m x src/*.ts', none],
	['sudo git push', none],
	['env git push', none],
	['command git push', none],
	['xargs git push', none],
	['hub pull-request', none],
	['git --exec-path', none],
	['git --version', none],
	// quoting and echo
	['echo "git push"', none],
	["echo 'git commit -m x'", none],
	['echo git push', none],
	['printf "git merge x"', none],
	['grep "git commit" notes.md', none],
	['cat <<EOF\ngit push\nEOF', none],
	// joins other than && are not read
	['git commit -m x; git push', none],
	['git push || true', none],
	['git commit -m x || echo failed', none],
	['git log | git commit -F -', none],
	['git commit -m x\ngit push', none],
	// refused by the splitter
	['git commit -m "$(date)"', none],
	['git commit -m `date`', none],
	['git commit -F - <<< "message"', none],
	['git commit -F - <<EOF\nmsg\nEOF', none],
	['git push &', none],
	['(git push)', none],
	['git push > out.txt', none],
	['git log > out.txt && git commit -m x', none],
	// harmless redirects
	['git push 2>&1', ['push']],
	['git commit -m x > /dev/null', ['commit']],
]

describe('version-control actions in a command line', () => {
	it('has at least sixty lines', () => {
		expect(TABLE.length).toBeGreaterThanOrEqual(60)
	})
	for (const [command, expected] of TABLE) {
		it(`${JSON.stringify(command)} counts ${expected.length === 0 ? 'nothing' : expected.join(', ')}`, () => {
			expect(vcsActions(command).actions).toEqual(expected)
		})
	}
})

describe('a command that is only version control leaves the plain count', () => {
	it('is absorbed when every piece is an action or harmless around one', () => {
		expect(vcsActions('git add -A && git commit -m x && git push').absorbed).toBe(true)
		expect(vcsActions('cd sub && git push').absorbed).toBe(true)
	})
	it('stays a plain command as well when something else ran in it', () => {
		expect(vcsActions('pnpm test && git commit -m x').absorbed).toBe(false)
		expect(vcsActions('git status').absorbed).toBe(false)
	})
})

const run = (command: string) => ({
	kind: 'run' as const,
	command,
	cell: { header: `Bash(${command})`, shell: { stdout: ['ok'], stderr: [], failed: false } },
})

const SESSION = [
	'git switch -c topic',
	'pnpm build',
	'git add -A && git commit -m "push it"',
	'git commit --amend --no-edit',
	'git push -u origin topic',
	'gh pr create --fill',
	'git status',
]

describe('the folded line names what the commands did', () => {
	const live = SESSION.reduce<GroupState>(
		(state, command) => foldOp(state, run(command)),
		EMPTY_GROUP,
	)

	it('counts by action in a fixed order and keeps every other command in the plain count', () => {
		expect(groupText(live, false)).toBe(
			'Made 1 commit, amended 1 commit, pushed 1 time, created 1 branch, opened 1 pull request, ran 2 commands',
		)
	})

	it('uses the running verbs while live', () => {
		expect(groupText(live, true)).toBe(
			'Making 1 commit, amending 1 commit, pushing 1 time, creating 1 branch, opening 1 pull request, running 2 commands…',
		)
	})

	it('only goes up as commands arrive', () => {
		let state = EMPTY_GROUP
		let before = 0
		for (const command of [...SESSION, 'git commit -m again', 'git push']) {
			state = foldOp(state, run(command))
			const text = groupText(state, true)
			const total = [...text.matchAll(/\d+/g)].reduce((sum, m) => sum + Number(m[0]), 0)
			expect(total).toBeGreaterThanOrEqual(before)
			before = total
		}
	})

	it('reads the same when rebuilt from one stored row per command, as on resume and in watch', () => {
		const stored: TranscriptMessage[] = SESSION.map((command, index) => {
			const group = foldOp(EMPTY_GROUP, run(command))
			return {
				id: `r${index}`,
				role: 'tool',
				content: command,
				group,
				detail: [command],
			} as TranscriptMessage
		})
		const merged = mergeGroupRows(stored)
		expect(merged).toHaveLength(1)
		expect(merged[0]?.content).toBe(groupText(live, false))
		expect(merged[0]?.group?.commands).toEqual(live.commands)
		expect(groupFields(merged[0]?.group as GroupState, false).content).toBe(groupText(live, false))
	})

	it('words the switch and the merges plainly', () => {
		const state = [
			'git switch a',
			'git switch b',
			'git merge a',
			'git rebase main',
			'gh pr merge 3',
		].reduce<GroupState>((s, command) => foldOp(s, run(command)), EMPTY_GROUP)
		expect(groupText(state, false)).toBe(
			'Switched branches 2 times, merged 1 branch, rebased 1 time, merged 1 pull request',
		)
	})
})
