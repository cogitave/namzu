import { expect, it } from 'vitest'

import { createTurnContextEntry } from '../../../types/message/index.js'
import type { SessionRecord } from '../../../types/session/records.js'
import { evidenceTexts } from '../fts.js'

/**
 * A recorded context entry is what the host recalled for the model. Once a
 * compaction sheds it, indexing it would make a search find its own earlier
 * recall and present it as something said in the session.
 */
it('indexes the messages a compaction shed, but not the recorded context among them', () => {
	const record = {
		type: 'compaction_shed',
		messages: [
			{ role: 'user', content: 'fix the parser' },
			createTurnContextEntry('evidence', 'RECALLED PASSAGE'),
			{ role: 'assistant', content: 'done' },
		],
	} as unknown as SessionRecord
	const texts = evidenceTexts(record)
	expect(texts.map((t) => t.text)).toEqual(['fix the parser', 'done'])
	expect(texts.map((t) => t.source)).toEqual(['compaction_shed:user', 'compaction_shed:assistant'])
})
