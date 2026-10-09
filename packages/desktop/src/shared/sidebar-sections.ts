/** The sidebar groups the person can fold away. */
export const SIDEBAR_SECTIONS = ['pals', 'projects', 'recents'] as const
export type SidebarSectionId = (typeof SIDEBAR_SECTIONS)[number]

export function isSidebarSection(value: unknown): value is SidebarSectionId {
	return typeof value === 'string' && (SIDEBAR_SECTIONS as readonly string[]).includes(value)
}

/**
 * The collapsed sections read back from saved state. Anything that is not a known section name
 * is dropped, so a missing, damaged or newer-version value leaves the section expanded instead
 * of costing the person the rest of the saved file.
 */
export function collapsedSectionsFrom(input: unknown): SidebarSectionId[] {
	if (!Array.isArray(input)) return []
	const known = new Set<SidebarSectionId>()
	for (const item of input) if (isSidebarSection(item)) known.add(item)
	return SIDEBAR_SECTIONS.filter((id) => known.has(id))
}
