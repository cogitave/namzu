/** A blank composer belongs to its pane, independently of a project's other conversations. */
export function projectDraftOwner(owner: unknown): {
	projectId: string
	workspace?: { windowId: string; groupId: string }
} | null {
	if (typeof owner !== 'string' || !owner.startsWith('project:')) return null
	const value = owner.slice('project:'.length)
	const separator = ':workspace:'
	const at = value.indexOf(separator)
	if (at < 0) return { projectId: value }
	const projectId = value.slice(0, at)
	const parts = value.slice(at + separator.length).split(':')
	if (
		!projectId ||
		parts.length !== 2 ||
		parts.some((part) => !part || part.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(part))
	)
		throw new Error('Invalid project draft owner.')
	return { projectId, workspace: { windowId: parts[0] as string, groupId: parts[1] as string } }
}
