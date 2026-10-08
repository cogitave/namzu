import { describe, expect, it } from 'vitest'
import { DEFAULT_HOME_HEADING, newProjectFailure, projectHomeHeading } from './project-home.js'

describe('projectHomeHeading', () => {
	it('names the project on its home', () => {
		expect(projectHomeHeading({ name: 'New project' })).toBe(
			'What should we work on in New project?',
		)
	})
	it('keeps the general heading for chats, Pal workspaces and no project', () => {
		expect(projectHomeHeading({ name: 'x', isChat: true })).toBe(DEFAULT_HOME_HEADING)
		expect(projectHomeHeading({ name: 'x', palId: 'p' })).toBe(DEFAULT_HOME_HEADING)
		expect(projectHomeHeading(undefined)).toBe(DEFAULT_HOME_HEADING)
	})
})

describe('newProjectFailure', () => {
	it('puts the cause after the fixed lead and drops the wrapper Electron adds', () => {
		const wrapped = new Error(
			"Error invoking remote method 'namzu:createProject': Error: EACCES: denied",
		)
		expect(newProjectFailure(wrapped).message).toBe("Couldn't create a new project: EACCES: denied")
		expect(newProjectFailure('plain').message).toBe("Couldn't create a new project: plain")
	})
})
