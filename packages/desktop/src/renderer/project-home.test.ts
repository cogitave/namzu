import { describe, expect, it } from 'vitest'
import {
	DEFAULT_HOME_HEADING,
	createdProjectNotice,
	homeStarters,
	newProjectFailure,
	projectHomeHeading,
} from './project-home.js'

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

describe('homeStarters', () => {
	it('offers file-based ideas only where there is a project', () => {
		expect(homeStarters({})[0]).toBe('Explore this project')
		for (const none of [undefined, { isChat: true as const }, { palId: 'p' }])
			for (const label of homeStarters(none)) expect(label).not.toMatch(/project|change/i)
	})
	it('offers ideas that fit a folder with nothing in it yet', () => {
		expect(homeStarters({ emptyFolder: true })).toEqual([
			'Plan a project',
			'Create a first file',
			'Describe what you want to build',
		])
		for (const label of homeStarters({ emptyFolder: true }))
			expect(label).not.toMatch(/explore|review/i)
	})
})

describe('createdProjectNotice', () => {
	it('says which folder holds the new project, in either path style', () => {
		expect(
			createdProjectNotice({ name: 'New project', path: '/home/me/Documents/Namzu/New project' }),
		).toBe('Created \u201cNew project\u201d in /home/me/Documents/Namzu.')
		expect(
			createdProjectNotice({
				name: 'New project 2',
				path: 'C:\\Users\\me\\Documents\\Namzu\\New project 2',
			}),
		).toBe('Created \u201cNew project 2\u201d in C:\\Users\\me\\Documents\\Namzu.')
	})
})
