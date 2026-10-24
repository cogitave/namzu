/**
 * Per-flag allowlists for the shell commands that may run without a prompt.
 *
 * For each command, the flags it vets and what each takes, `none` (a switch), `string` or `number`.
 * A flag not listed here is not read-only, which is how `git diff --output=f`
 * (writes a file), `git -c`, `--exec-path` and `--config-env` stay out: they
 * are not in any table. Space-separated lists per kind keep the file readable;
 * `readonly-commands.ts` holds the callbacks that need more than a flag name.
 */

export type FlagKind = 'none' | 'string' | 'number'

export interface FlagTable {
	readonly flags: Readonly<Record<string, FlagKind>>
	/** False when `--` does not end the options for this command. */
	readonly doubleDash: boolean
}

function table(spec: {
	none?: string
	string?: string
	number?: string
	doubleDash?: false
}): FlagTable {
	const flags: Record<string, FlagKind> = {}
	for (const kind of ['none', 'string', 'number'] as const) {
		for (const flag of (spec[kind] ?? '').split(' ')) if (flag !== '') flags[flag] = kind
	}
	return { flags, doubleDash: spec.doubleDash !== false }
}

/** Keyed by the command words that select the table (`git diff`, `rg`). */
export const FLAG_TABLES: Readonly<Record<string, FlagTable>> = {
	'git diff': table({
		none: '--stat --numstat --shortstat --name-only --name-status --color --no-color --dirstat --summary --patch-with-stat --word-diff --color-words --no-renames --no-ext-diff --check --full-index --binary --break-rewrites --find-renames --find-copies --find-copies-harder --irreversible-delete --histogram --patience --minimal --ignore-space-at-eol --ignore-space-change --ignore-all-space --ignore-blank-lines --function-context --exit-code --quiet --cached --staged --pickaxe-regex --pickaxe-all --no-index -p -u -s -M -C -B -D -l -R',
		string:
			'--word-diff-regex --ws-error-highlight --diff-algorithm --relative --diff-filter -S -G -O',
		number: '--abbrev --inter-hunk-context',
	}),
	'git log': table({
		none: '--oneline --graph --decorate --no-decorate --relative-date --all --branches --tags --remotes --stat --numstat --shortstat --name-only --name-status --color --no-color --patch -p --no-patch --no-ext-diff -s --abbrev-commit --full-history --dense --sparse --simplify-merges --ancestry-path --source --first-parent --merges --no-merges --reverse --walk-reflogs --no-min-parents --no-max-parents --follow --no-walk --left-right --cherry-mark --cherry-pick --boundary --topo-order --date-order --author-date-order --pickaxe-regex --pickaxe-all',
		string:
			'--date --since --after --until --before --author --committer --grep --pretty --format --diff-filter -S -G',
		number: '--max-count -n --skip --max-age --min-age',
	}),
	'git show': table({
		none: '--oneline --graph --decorate --no-decorate --relative-date --stat --numstat --shortstat --name-only --name-status --color --no-color --patch -p --no-patch --no-ext-diff -s --abbrev-commit --word-diff --color-words --first-parent --raw -m --quiet',
		string: '--date --word-diff-regex --pretty --format --diff-filter',
	}),
	'git shortlog': table({
		none: '--all --branches --tags --remotes -s --summary -n --numbered -e --email -c --committer --no-merges',
		string: '--since --after --until --before --group --format --author',
	}),
	'git reflog': table({
		none: '--oneline --graph --decorate --no-decorate --relative-date --all --branches --tags --remotes',
		string: '--date --since --after --until --before --author --committer --grep',
		number: '--max-count -n',
	}),
	'git stash list': table({
		none: '--oneline --graph --decorate --no-decorate --relative-date --all --branches --tags --remotes',
		string: '--date',
		number: '--max-count -n',
		doubleDash: false,
	}),
	'git ls-remote': table({
		none: '--branches -b --tags -t --heads -h --refs --quiet -q --exit-code --get-url --symref',
		string: '--sort',
	}),
	'git status': table({
		none: '--short -s --branch -b --porcelain --long --verbose -v --ignored --column --no-column --ahead-behind --no-ahead-behind --renames --no-renames',
		string: '--untracked-files -u --ignore-submodules --find-renames -M',
	}),
	'git blame': table({
		none: '--color --no-color --porcelain -p --line-porcelain --incremental --root --show-stats --show-name --show-number -n --show-email -e -f -w -M -C --score-debug -s -l -t',
		string: '-L --date --ignore-rev --ignore-revs-file',
		number: '--abbrev',
		doubleDash: false,
	}),
	'git ls-files': table({
		none: '--cached -c --deleted -d --modified -m --others -o --ignored -i --stage -s --killed -k --unmerged -u --directory --no-empty-directory --eol --full-name --debug -z -t -v -f --exclude-standard --error-unmatch --recurse-submodules',
		string: '--exclude -x --exclude-from -X --exclude-per-directory',
		number: '--abbrev',
	}),
	'git config --get': table({
		none: '--local --global --system --worktree --bool --int --bool-or-int --path --expiry-date -z --null --name-only --show-origin --show-scope',
		string: '--default --type',
	}),
	'git remote show': table({
		none: '-n',
	}),
	'git remote': table({
		none: '-v --verbose',
	}),
	'git merge-base': table({
		none: '--is-ancestor --fork-point --octopus --independent --all',
	}),
	'git rev-parse': table({
		none: '--verify --abbrev-ref --symbolic --symbolic-full-name --show-toplevel --show-cdup --show-prefix --git-dir --git-common-dir --absolute-git-dir --show-superproject-working-tree --is-inside-work-tree --is-inside-git-dir --is-bare-repository --is-shallow-repository --is-shallow-update --path-prefix',
		string: '--short',
	}),
	'git rev-list': table({
		none: '--all --branches --tags --remotes --count --reverse --first-parent --ancestry-path --merges --no-merges --no-min-parents --no-max-parents --walk-reflogs --oneline --abbrev-commit --full-history --dense --sparse --source --graph',
		string: '--since --after --until --before --author --committer --grep --pretty --format',
		number: '--max-count -n --min-parents --max-parents --skip --max-age --min-age --abbrev',
	}),
	'git describe': table({
		none: '--tags --long --always --contains --first-match --exact-match --dirty --broken',
		string: '--match --exclude',
		number: '--abbrev --candidates',
	}),
	'git cat-file': table({
		none: '-t -s -p -e --batch-check --allow-undetermined-type',
	}),
	'git for-each-ref': table({
		string: '--format --sort --contains --no-contains --merged --no-merged --points-at',
		number: '--count',
	}),
	'git grep': table({
		none: '-E --extended-regexp -G --basic-regexp -F --fixed-strings -P --perl-regexp -i --ignore-case -v --invert-match -w --word-regexp -n --line-number -c --count -l --files-with-matches -L --files-without-match -h -H --heading --break --full-name --color --no-color -o --only-matching --and --or --not --untracked --no-index --recurse-submodules --cached -q --quiet',
		string: '-e',
		number: '-A --after-context -B --before-context -C --context --max-depth --threads',
	}),
	'git stash show': table({
		none: '--stat --numstat --shortstat --name-only --name-status --color --no-color --patch -p --no-patch --no-ext-diff -s --word-diff',
		string: '--word-diff-regex --diff-filter',
		number: '--abbrev',
	}),
	'git worktree list': table({
		none: '--porcelain -v --verbose',
		string: '--expire',
	}),
	'git tag': table({
		none: '-l --list --column --no-column -i --ignore-case',
		string: '--contains --no-contains --merged --no-merged --sort --format --points-at',
		number: '-n',
	}),
	'git branch': table({
		none: '-l --list -a --all -r --remotes -v -vv --verbose --color --no-color --column --no-column --no-abbrev --merged --no-merged --show-current -i --ignore-case',
		string: '--contains --no-contains --points-at --sort',
		number: '--abbrev',
	}),
	file: table({
		none: '--brief -b --mime -i --mime-type --mime-encoding --apple --check-encoding -c --print0 -0 --help --version -v --no-dereference -h --dereference -L --keep-going -k --list -l --no-buffer -n --preserve-date -p --raw -r -s --special-files',
		string: '--exclude --exclude-quiet -F --separator',
	}),
	sort: table({
		none: '--ignore-leading-blanks -b --dictionary-order -d --ignore-case -f --general-numeric-sort -g --human-numeric-sort -h --ignore-nonprinting -i --month-sort -M --numeric-sort -n --random-sort -R --reverse -r --stable -s --unique -u --version-sort -V --zero-terminated -z --check -c --check-char-order -C --merge -m --help --version',
		string: '--sort --key -k --field-separator -t --buffer-size -S',
		number: '--parallel --batch-size',
	}),
	base64: table({
		none: '-d -D --decode --ignore-garbage -h --help --version',
		string: '-i --input',
		number: '-b --break -w --wrap',
		doubleDash: false,
	}),
	grep: table({
		none: '-F --fixed-strings -G --basic-regexp -E --extended-regexp -P --perl-regexp -i --ignore-case --no-ignore-case -v --invert-match -w --word-regexp -x --line-regexp -c --count -L --files-without-match -l --files-with-matches -o --only-matching -q --quiet --silent -s --no-messages -b --byte-offset -H --with-filename -h --no-filename -n --line-number -T --initial-tab -u --unix-byte-offsets -Z --null -z --null-data --no-group-separator -a --text -I -r --recursive -R --dereference-recursive --line-buffered -U --binary --help -V --version',
		string:
			'-e --regexp -f --file --color --colour --label --group-separator --binary-files -D --devices -d --directories --exclude --exclude-from --exclude-dir --include',
		number: '-m --max-count -A --after-context -B --before-context -C --context',
	}),
	egrep: table({
		none: '-F --fixed-strings -G --basic-regexp -E --extended-regexp -P --perl-regexp -i --ignore-case --no-ignore-case -v --invert-match -w --word-regexp -x --line-regexp -c --count -L --files-without-match -l --files-with-matches -o --only-matching -q --quiet --silent -s --no-messages -b --byte-offset -H --with-filename -h --no-filename -n --line-number -T --initial-tab -u --unix-byte-offsets -Z --null -z --null-data --no-group-separator -a --text -I -r --recursive -R --dereference-recursive --line-buffered -U --binary --help -V --version',
		string:
			'-e --regexp -f --file --color --colour --label --group-separator --binary-files -D --devices -d --directories --exclude --exclude-from --exclude-dir --include',
		number: '-m --max-count -A --after-context -B --before-context -C --context',
	}),
	fgrep: table({
		none: '-F --fixed-strings -G --basic-regexp -E --extended-regexp -P --perl-regexp -i --ignore-case --no-ignore-case -v --invert-match -w --word-regexp -x --line-regexp -c --count -L --files-without-match -l --files-with-matches -o --only-matching -q --quiet --silent -s --no-messages -b --byte-offset -H --with-filename -h --no-filename -n --line-number -T --initial-tab -u --unix-byte-offsets -Z --null -z --null-data --no-group-separator -a --text -I -r --recursive -R --dereference-recursive --line-buffered -U --binary --help -V --version',
		string:
			'-e --regexp -f --file --color --colour --label --group-separator --binary-files -D --devices -d --directories --exclude --exclude-from --exclude-dir --include',
		number: '-m --max-count -A --after-context -B --before-context -C --context',
	}),
	rg: table({
		none: '-i --ignore-case -S --smart-case -F --fixed-strings -w --word-regexp -v --invert-match -c --count -l --files-with-matches --files-without-match -n --line-number -o --only-matching -H -h --heading --no-heading -q --quiet --column --type-list --hidden --no-ignore -u -a --text -L --follow --json --stats --help --version --debug --',
		string: '-e --regexp -f -g --glob -t --type -T --type-not --color',
		number: '-A --after-context -B --before-context -C --context -m --max-count -d --max-depth',
	}),
	sha256sum: table({
		none: '-b --binary -t --text -c --check --ignore-missing --quiet --status --strict -w --warn --tag -z --zero --help --version',
	}),
	sha1sum: table({
		none: '-b --binary -t --text -c --check --ignore-missing --quiet --status --strict -w --warn --tag -z --zero --help --version',
	}),
	md5sum: table({
		none: '-b --binary -t --text -c --check --ignore-missing --quiet --status --strict -w --warn --tag -z --zero --help --version',
	}),
	tree: table({
		none: '-a -d -l -f -x --gitignore --ignore-case --matchdirs --metafirst --prune --info --noreport -q -N -Q -p -u -g -s -h --si --du -D -F --inodes --device -v -t -c -U -r --dirsfirst --filesfirst -i -A -S -n -C -X -J --nolinks --hyperlink --fromfile --fromtabfile --fflinks --help --version',
		string:
			'-P -I --gitfile --infofile --charset --timefmt --sort -H --hintro --houtro -T --scheme --authority',
		number: '-L --filelimit',
	}),
}
