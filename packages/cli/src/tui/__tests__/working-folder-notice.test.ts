import { parse } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	ROOT_FOLDER_NOTICE,
	WORKING_FOLDER_NOTICE,
	workingFolderNotice,
} from '../working-folder-notice.js'

describe('the working folder notice', () => {
	const home = process.platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone'

	it('shows when the working folder is the home folder', () => {
		expect(workingFolderNotice(home, home)).toBe(WORKING_FOLDER_NOTICE)
		expect(workingFolderNotice(`${home}/`, home)).toBe(WORKING_FOLDER_NOTICE)
	})

	it('shows at the filesystem root', () => {
		expect(workingFolderNotice(parse(home).root, home)).toBe(ROOT_FOLDER_NOTICE)
	})

	it('stays quiet in a project folder or a folder under home', () => {
		expect(workingFolderNotice(`${home}/projects/app`, home)).toBeNull()
		expect(workingFolderNotice(`${home}/projects`, home)).toBeNull()
		expect(workingFolderNotice(home, undefined)).toBeNull()
	})
})
