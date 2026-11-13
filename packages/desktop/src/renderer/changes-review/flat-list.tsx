import { formatLineCount } from '../changes-totals.js'
import type { ReviewFile } from './model.js'

const baseName = (path: string) => path.split('/').pop() || path
const dirName = (path: string) => path.split('/').slice(0, -1).join('/')

/**
 * Where two files share a name, the folder is added so they can be told apart; otherwise a file
 * is its name alone, which is what fits a narrow list.
 */
export function listNames(files: readonly Pick<ReviewFile, 'path'>[]): Map<string, string> {
	const counts = new Map<string, number>()
	for (const file of files)
		counts.set(baseName(file.path), (counts.get(baseName(file.path)) ?? 0) + 1)
	return new Map(
		files.map((file) => {
			const name = baseName(file.path)
			const dir = dirName(file.path)
			return [file.path, (counts.get(name) ?? 0) > 1 && dir ? `${name} · ${dir}` : name]
		}),
	)
}

/** A short list of changed files by name: one row each, the file's counts at its end. */
export function FlatFileList({
	files,
	selected,
	onSelect,
}: {
	files: readonly ReviewFile[]
	selected?: string
	onSelect: (path: string) => void
}) {
	const names = listNames(files)
	return (
		<ul className="changes-flat" aria-label="Changed files">
			{files.map((file) => {
				const active = file.path === selected
				return (
					<li key={file.path}>
						<button
							type="button"
							className="changes-flat-row"
							data-active={active || undefined}
							data-status={file.status}
							aria-current={active || undefined}
							title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
							onClick={() => onSelect(file.path)}
						>
							<span className="changes-flat-name">{baseName(file.path)}</span>
							{/* Two files of one name are told apart by their folder, which gives way before the name does. */}
							{names.get(file.path) !== baseName(file.path) && (
								<span className="changes-flat-folder">{dirName(file.path)}</span>
							)}
							{file.status === 'binary' || file.binary ? (
								<span className="changes-tree-note">binary</span>
							) : (
								<span className="changes-tree-counts">
									{file.added > 0 && (
										<span className="changes-added">+{formatLineCount(file.added)}</span>
									)}
									{file.removed > 0 && (
										<span className="changes-removed">−{formatLineCount(file.removed)}</span>
									)}
								</span>
							)}
						</button>
					</li>
				)
			})}
		</ul>
	)
}
