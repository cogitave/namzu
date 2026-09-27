import { generateSessionId } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { displayConversationTitle } from '../../integrations/sessions/display-title.js'
import type { RecentConversation } from '../../integrations/sessions/store.js'
import { ResumePicker } from '../ResumePicker.js'

describe('old scheduled conversation titles in /resume', () => {
	it('shows a text label without changing the saved title', () => {
		const conversation: RecentConversation = {
			id: generateSessionId(),
			title: '⏲ nightly-report · 27 Sept 2026, 11:32',
			named: true,
			updatedAt: '2026-09-27T11:32:00Z',
			count: 2,
		}
		const picker = render(<ResumePicker conversations={[conversation]} selected={0} />)
		try {
			const frame = picker.lastFrame() ?? ''
			expect(frame).toContain('"Scheduled: nightly-report · 27 Sept 2026, 11:32"')
			expect(frame).not.toContain('⏲')
			expect(displayConversationTitle(conversation.title)).toBe(
				'Scheduled: nightly-report · 27 Sept 2026, 11:32',
			)
			expect(conversation.title).toBe('⏲ nightly-report · 27 Sept 2026, 11:32')
			expect(displayConversationTitle('⏲ a name without a scheduled time')).toBe(
				'⏲ a name without a scheduled time',
			)
		} finally {
			picker.unmount()
		}
	})
})
