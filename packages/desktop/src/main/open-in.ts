import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Hands a project path to an editor, the file manager or a terminal. The program is always
 * one this module found itself, the arguments are separate argv entries with no shell, and
 * the path was confined to the project before it got here.
 */

export type EditorId = 'vscode' | 'cursor'
export interface Editor {
	id: EditorId
	label: string
	executable: string
}
export type OpenTarget = 'editor' | 'file-manager' | 'terminal'

export interface OpenInHost {
	platform: NodeJS.Platform
	env: Readonly<Record<string, string | undefined>>
	isFile(path: string): Promise<boolean>
	launch(file: string, args: string[]): Promise<void>
	showItemInFolder(path: string): void
	openPath(path: string): Promise<string>
}

const EDITORS: { id: EditorId; label: string; windows: string[]; unix: string }[] = [
	{
		id: 'vscode',
		label: 'VS Code',
		windows: ['Programs', 'Microsoft VS Code', 'Code.exe'],
		unix: 'code',
	},
	{ id: 'cursor', label: 'Cursor', windows: ['Programs', 'cursor', 'Cursor.exe'], unix: 'cursor' },
]

export const MAX_EDITOR_LINE = 10_000_000

export class OpenIn {
	constructor(private readonly host: OpenInHost) {}

	private get windows(): boolean {
		return this.host.platform === 'win32'
	}

	private pathEntries(): string[] {
		const raw = this.host.env.PATH ?? this.host.env.Path ?? ''
		return raw.split(this.windows ? ';' : ':').filter(Boolean)
	}

	private async firstFile(candidates: string[]): Promise<string | undefined> {
		for (const candidate of candidates) if (await this.host.isFile(candidate)) return candidate
		return undefined
	}

	async editors(): Promise<Editor[]> {
		const found: Editor[] = []
		const path = this.windows ? win32 : posix
		for (const editor of EDITORS) {
			const names = this.windows ? [editor.windows.at(-1) as string] : [editor.unix]
			const candidates = this.pathEntries().flatMap((entry) =>
				names.map((n) => path.join(entry, n)),
			)
			const local = this.host.env.LOCALAPPDATA
			if (this.windows) {
				// Per-user installs first, then the system-wide ones under Program Files.
				const roots = [
					this.host.env.ProgramFiles,
					this.host.env.ProgramW6432,
					this.host.env['ProgramFiles(x86)'],
				].filter((root): root is string => Boolean(root))
				const system = roots.map((root) => win32.join(root, ...editor.windows.slice(1)))
				candidates.unshift(...(local ? [win32.join(local, ...editor.windows)] : []), ...system)
			}
			const executable = await this.firstFile(candidates)
			if (executable) found.push({ id: editor.id, label: editor.label, executable })
		}
		return found
	}

	async open(
		absolute: string,
		kind: 'file' | 'directory',
		target: OpenTarget,
		line?: number,
	): Promise<void> {
		if (target === 'editor') {
			const editor = (await this.editors())[0]
			if (!editor) throw new Error('No supported editor was found on this computer.')
			const useLine = kind === 'file' && Number.isInteger(line) && (line as number) >= 1
			await this.host.launch(
				editor.executable,
				useLine && (line as number) <= MAX_EDITOR_LINE
					? ['--goto', `${absolute}:${line}`]
					: [absolute],
			)
			return
		}
		if (target === 'file-manager') {
			if (kind === 'file') {
				this.host.showItemInFolder(absolute)
				return
			}
			const failure = await this.host.openPath(absolute)
			if (failure) throw new Error('The file manager could not open this folder.')
			return
		}
		if (target === 'terminal') {
			if (!this.windows) throw new Error('Opening a terminal is not available on this computer.')
			const local = this.host.env.LOCALAPPDATA
			const terminal = await this.firstFile([
				...(local ? [win32.join(local, 'Microsoft', 'WindowsApps', 'wt.exe')] : []),
				...this.pathEntries().map((entry) => win32.join(entry, 'wt.exe')),
			])
			if (!terminal) throw new Error('Windows Terminal was not found on this computer.')
			await this.host.launch(terminal, [
				'-d',
				kind === 'directory' ? absolute : win32.dirname(absolute),
			])
			return
		}
		throw new Error('That way of opening is not supported.')
	}
}

/** The real host: no shell, the child outlives the app's request and is never waited on. */
export function systemOpenInHost(electron: {
	showItemInFolder(path: string): void
	openPath(path: string): Promise<string>
}): OpenInHost {
	return {
		platform: process.platform,
		env: process.env,
		isFile: async (path) => {
			try {
				return (await stat(path)).isFile()
			} catch {
				return false
			}
		},
		launch: (file, args) =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(file, args, { shell: false, detached: true, stdio: 'ignore' })
				child.once('error', () => reject(new Error('The program could not be started.')))
				child.once('spawn', () => {
					child.unref()
					resolve()
				})
			}),
		showItemInFolder: electron.showItemInFolder,
		openPath: electron.openPath,
	}
}
