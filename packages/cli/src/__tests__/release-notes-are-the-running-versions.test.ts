import { describe, expect, it } from 'vitest'

import { changelogSection, changelogVersions, renderReleaseNotes } from '../release-notes.js'

const changelog = `# @namzu/cli

## 18.1.0

### Minor Changes

- abc: two modes.

## 18.0.0

### Major Changes

- def: the big one.
`

describe('/release-notes', () => {
	it('finds the section for a version and stops at the next', () => {
		expect(changelogSection(changelog, '18.1.0')?.body).toBe(
			'### Minor Changes\n\n- abc: two modes.',
		)
		expect(changelogSection(changelog, '18.0.0')?.body).toBe(
			'### Major Changes\n\n- def: the big one.',
		)
		expect(changelogSection(changelog, '1.0.0')).toBeNull()
		expect(changelogVersions(changelog)).toEqual(['18.1.0', '18.0.0'])
	})

	it('renders the running version, and says which versions exist when asked for one it lacks', () => {
		expect(renderReleaseNotes(changelog, '18.1.0')).toBe(
			'@namzu/cli 18.1.0\n\n### Minor Changes\n\n- abc: two modes.',
		)
		expect(renderReleaseNotes(changelog, '9.9.9')).toContain('Versions with notes: 18.1.0, 18.0.0')
		expect(renderReleaseNotes(null)).toContain('No release notes')
	})
})
