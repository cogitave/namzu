import { describe, expect, it } from 'vitest'

import { RETIRED_BUILTIN_SKILLS, retiredSkill, retiredSkillNotice } from './retired.js'

describe('retired built-in skills', () => {
	it('answers a request for verify-change with one line that names /run', () => {
		const notice = retiredSkillNotice('verify-change')
		expect(notice).toBeDefined()
		expect(notice).toContain('/run')
		expect(notice).not.toContain('\n')
	})

	it('answers nothing for a name that was never retired, including inherited object keys', () => {
		expect(retiredSkillNotice('run')).toBeUndefined()
		expect(retiredSkillNotice('toString')).toBeUndefined()
		expect(retiredSkillNotice('__proto__')).toBeUndefined()
		expect(retiredSkill('constructor', '/x')).toBeUndefined()
	})

	it('loads as a model-only skill whose whole body is that line', () => {
		for (const name of Object.keys(RETIRED_BUILTIN_SKILLS)) {
			const skill = retiredSkill(name, '/skills')
			expect(skill?.body).toBe(retiredSkillNotice(name))
			expect(skill?.metadata.invocation).toBe('model')
		}
	})
})
