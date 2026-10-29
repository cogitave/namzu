import { generateSessionId } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import type { RecentConversation } from '../../integrations/sessions/store.js'
import { ResumePicker } from '../ResumePicker.js'

const base = (over: Partial<RecentConversation>): RecentConversation => ({
	id: generateSessionId(),
	title: 'Fix the build',
	named: false,
	updatedAt: '2026-10-27T11:32:00Z',
	count: 4,
	...over,
})

describe('the resume picker', () => {
	it('invites a search, names the list and offers the folder switch and rename', () => {
		const picker = render(<ResumePicker conversations={[base({})]} selected={0} />)
		try {
			const frame = picker.lastFrame() ?? ''
			expect(frame).toContain('type to search')
			expect(frame).toContain('This folder')
			expect(frame).toContain('ctrl+a all folders')
			expect(frame).toContain('ctrl+r rename')
		} finally {
			picker.unmount()
		}
	})

	it('shows what was typed and says plainly when nothing matches', () => {
		const picker = render(<ResumePicker conversations={[]} selected={0} query="zzz" />)
		try {
			const frame = picker.lastFrame() ?? ''
			expect(frame).toContain('Search: zzz')
			expect(frame).toContain('No conversation matches.')
		} finally {
			picker.unmount()
		}
	})

	it('previews the first lines and tags a row from another folder with its folder', () => {
		const picker = render(
			<ResumePicker
				conversations={[
					base({ firstPrompt: 'line one\nline two', preview: 'last words', folder: 'billing' }),
				]}
				selected={0}
				scope="all"
			/>,
		)
		try {
			const frame = picker.lastFrame() ?? ''
			expect(frame).toContain('All folders')
			expect(frame).toContain('billing')
			expect(frame).toContain('Started with: line one')
			expect(frame).toContain('line two')
			expect(frame).toContain('Last prompt: last words')
			expect(frame).toContain('ctrl+a this folder')
		} finally {
			picker.unmount()
		}
	})

	it('tags a conversation with the pull request it made', () => {
		const picker = render(
			<ResumePicker
				conversations={[
					base({
						pr: {
							number: 42,
							url: 'https://github.com/acme/widgets/pull/42',
							repository: 'acme/widgets',
						},
					}),
				]}
				selected={0}
			/>,
		)
		try {
			expect(picker.lastFrame() ?? '').toContain('acme/widgets#42')
		} finally {
			picker.unmount()
		}
	})

	it('swaps the search for the name being typed while renaming', () => {
		const picker = render(<ResumePicker conversations={[base({})]} selected={0} renaming="Build" />)
		try {
			const frame = picker.lastFrame() ?? ''
			expect(frame).toContain('Name: Build')
			expect(frame).toContain('enter save')
			expect(frame).not.toContain('type to search')
		} finally {
			picker.unmount()
		}
	})

	it('offers neither switch nor rename when restoring archived conversations', () => {
		const picker = render(<ResumePicker conversations={[base({})]} selected={0} mode="restore" />)
		try {
			const frame = picker.lastFrame() ?? ''
			expect(frame).not.toContain('ctrl+a')
			expect(frame).not.toContain('ctrl+r')
			expect(frame).not.toContain('This folder')
		} finally {
			picker.unmount()
		}
	})
})
