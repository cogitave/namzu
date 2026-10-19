import { describe, expect, it } from 'vitest'

import { isReadOnlyCommandLine } from '../readonly-commands.js'

const allowed = (line: string) => isReadOnlyCommandLine(line)

describe('lines that only read', () => {
	it.each([
		'ls',
		'ls -la src',
		'ls *.ts',
		'cat README.md',
		'cat /etc/hosts',
		'head -n 20 file.txt',
		'wc -l a b',
		'pwd',
		'whoami',
		'echo hello',
		'echo "a b" 2>&1',
		'diff a b',
		'du -sh .',
		'uniq -c',
		'jq .name package.json',
		'find . -name "*.ts" -type f',
		'cd src',
		'docker ps',
		'docker images',
		'node -v',
		'python3 --version',
		'LANG=C ls',
		'NO_COLOR=1 git status',
		'cat file < /dev/null',
		'ls > /dev/null',
		'ls 2>&1',
		'git status',
		'git status --short --branch',
		'git status -sb',
		'git diff',
		'git diff --cached --stat',
		'git diff HEAD~1 -- src/a.ts',
		'git diff --name-only main...HEAD',
		'git log --oneline -n 5',
		'git log -5 --stat',
		'git log --format=%H -3',
		'git log --pretty=oneline',
		'git show HEAD',
		'git show HEAD:src/a.ts',
		'git blame -L 1,5 file',
		'git branch',
		'git branch -a',
		'git branch --list "feat/*"',
		'git branch --merged main',
		'git tag',
		'git tag -l "v1.*"',
		'git ls-files',
		'git rev-parse --show-toplevel',
		'git describe --tags',
		'git remote -v',
		'git remote show -n origin',
		'git config --get user.email',
		'git stash list',
		'git for-each-ref --sort=-committerdate refs/heads',
		'git grep -n foo',
		'git ls-remote --tags',
		'grep -rn foo src',
		'grep -A5 foo file',
		'rg -n --hidden foo',
		'tree -L 2',
		'file a.bin',
		'sha256sum a',
		'git status && git diff',
		'git log --oneline | head -5',
		'ls\ncat a',
		'ls src | wc -l',
	])('allows %j', (line) => {
		expect(allowed(line)).toBe(true)
	})
})

describe('lines that do not', () => {
	it.each([
		['writes a file by redirection', 'ls > out.txt'],
		['appends', 'echo x >> out.txt'],
		['a redirection to a device other than null', 'echo x > /dev/tcp/host/80'],
		['a here-document', 'cat <<EOF\nx\nEOF'],
		['a variable', 'echo $HOME'],
		['a variable in double quotes', 'echo "$HOME"'],
		['a substitution', 'echo $(whoami)'],
		['a backtick', 'echo `whoami`'],
		['a subshell', '(ls)'],
		['a group', '{ ls; }'],
		['background', 'ls &'],
		['a glob on a command that executes or writes', 'rm *.log'],
		['a glob on find', 'find *.ts'],
		['an unlisted command', 'curl https://example.com'],
		['a shell', 'bash -c ls'],
		['a path-qualified program', '/bin/ls'],
		['a quoted program name', '"ls"'],
		['sudo', 'sudo ls'],
		['env', 'env ls'],
		['xargs', 'ls | xargs rm'],
		['a pipe into an unlisted command', 'ls | tee out'],
		['a rider after a read', 'ls; rm -rf x'],
		['a rider joined by and', 'git status && npm test'],
		['a non-allowlisted assignment', 'PATH=/tmp ls'],
		['an assignment only', 'FOO=1'],
		['an extra argument to pwd', 'pwd -P'],
		['cd with two arguments', 'cd a b'],
		['find -delete', 'find . -delete'],
		['find -exec', 'find . -exec rm {} ;'],
		['find -fprint', 'find . -fprint out'],
		['uniq with a file', 'uniq a b'],
		['jq from a file', 'jq -f prog.jq data.json'],
		['jq env', 'jq env'],
		['docker to another host', 'docker -H tcp://x ps'],
		['docker context', 'docker --context prod ps'],
		['~user', 'ls ~root'],
		['a brace list', 'ls {a,b}'],
		['a UNC path', 'cat //host/share/file'],
		['an empty line', ''],
		['an eval', 'eval ls'],
		['source', 'source ./env.sh'],
		['a function definition', 'f() { ls; }'],
		['a for loop', 'for f in a b; do cat $f; done'],
	])('refuses %s', (_why, line) => {
		expect(allowed(line)).toBe(false)
	})
})

describe('git is held to its table', () => {
	it.each([
		['--output writes a file', 'git diff --output=out.patch'],
		['--output as two words', 'git log --output out'],
		['-c config injection', 'git -c core.pager=x status'],
		['-c after the subcommand', 'git status -c x=y'],
		['--exec-path', 'git --exec-path=/tmp status'],
		['--config-env', 'git --config-env=a=B status'],
		['a global option before the subcommand', 'git -C other status'],
		['fetch is absent', 'git fetch'],
		['commit', 'git commit -m x'],
		['push', 'git push'],
		['checkout', 'git checkout main'],
		['branch creation', 'git branch newbranch'],
		['branch deletion', 'git branch -D old'],
		['tag creation', 'git tag v1'],
		['tag deletion', 'git tag -d v1'],
		['remote add', 'git remote add x y'],
		['stash pop', 'git stash pop'],
		['reflog expire', 'git reflog expire --all'],
		['ls-remote of a host', 'git ls-remote https://example.com/x.git'],
		['ls-remote with a server option', 'git ls-remote -o x --tags'],
		['a signature format', 'git log --format=%GG'],
		['a named format read from config', 'git log --pretty=myformat'],
		['an unknown flag', 'git diff --textconv-everything'],
		['a value that is a flag', 'git log --author --stat'],
		['a missing value', 'git log --author'],
		['a value of the wrong kind', 'git log -n many'],
		['a switch given a value', 'git diff --stat=10'],
		['a variable argument', 'git diff $BRANCH'],
		['git next to cd', 'cd sub && git status'],
		['config set', 'git config user.name x'],
		['config --get with a write flag', 'git config --get --add a b'],
	])('refuses: %s', (_why, line) => {
		expect(allowed(line)).toBe(false)
	})

	it('reads the same flags the reference vets, including numbers and valued switches', () => {
		expect(allowed('git log --max-count=3 --author=me --since=2.weeks')).toBe(true)
		expect(allowed('git diff -U3')).toBe(false)
		expect(allowed('git diff --word-diff-regex=. --abbrev=8')).toBe(true)
	})
})

describe('the line is read as the shell reads it', () => {
	it('allows an operator inside quotes', () => {
		expect(allowed('echo "a && b; c | d"')).toBe(true)
		expect(allowed("grep -n 'foo(bar)' file")).toBe(true)
	})

	it('allows a single-quoted dollar', () => {
		expect(allowed("echo '$HOME'")).toBe(true)
	})

	it('refuses a line too long to analyse', () => {
		expect(allowed(`echo ${'a'.repeat(21_000)}`)).toBe(false)
	})

	it('refuses the cmd dialect', () => {
		expect(isReadOnlyCommandLine('dir', 'cmd')).toBe(false)
	})
})
