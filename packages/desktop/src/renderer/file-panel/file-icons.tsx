import { ArchiveRestore, Code, ExternalLink, File, FolderTree } from 'lucide-react'
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

export const FileIcon = (props: IconProps) => <File aria-hidden="true" {...props} />
export const FolderTreeIcon = (props: IconProps) => <FolderTree aria-hidden="true" {...props} />
export const ArchiveRestoreIcon = (props: IconProps) => (
	<ArchiveRestore aria-hidden="true" {...props} />
)
export const CodeIcon = (props: IconProps) => <Code aria-hidden="true" {...props} />
export const ExternalLinkIcon = (props: IconProps) => <ExternalLink aria-hidden="true" {...props} />

/** The editor mark: a folded ribbon, drawn once so the menu and the split button agree. */
export function VsCodeIcon(props: IconProps) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
			<path
				fill="#2489ca"
				d="M17.5 2.3 8.9 10.1 4.4 6.7 2.5 7.6v8.8l1.9.9 4.5-3.4 8.6 7.8 4-1.9V4.2zM4.5 14.2V9.8L7 12zm13 2.2L11 12l6.5-4.4z"
			/>
		</svg>
	)
}
