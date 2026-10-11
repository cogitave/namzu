import { describe, expect, it } from 'vitest'

import { displayPath, homePath } from '../person-terms.js'

const win = { sep: '\\' } as const
const posix = { sep: '/' } as const

describe('paths use the platform separator', () => {
	it('spells home and the rest with backslashes on Windows', () => {
		expect(homePath('C:\\Users\\ada\\Work\\clients\\leaf', 'C:\\Users\\ada', win)).toBe(
			'~\\Work\\clients\\leaf',
		)
		expect(homePath('C:/Users/ada/Work/leaf', 'C:\\Users\\ada', win)).toBe('~\\Work\\leaf')
		expect(homePath('c:\\users\\ada\\Work', 'C:\\Users\\ada', win)).toBe('~\\Work')
		expect(homePath('D:/elsewhere/app', 'C:\\Users\\ada', win)).toBe('D:\\elsewhere\\app')
		expect(homePath('C:\\Users\\adam\\x', 'C:\\Users\\ada', win)).toBe('C:\\Users\\adam\\x')
		expect(homePath('C:\\Users\\ada', 'C:\\Users\\ada', win)).toBe('~')
	})

	it('spells it with slashes on POSIX', () => {
		expect(homePath('/home/ada/Work/leaf', '/home/ada', posix)).toBe('~/Work/leaf')
		expect(homePath('/home/adam/x', '/home/ada', posix)).toBe('/home/adam/x')
		expect(homePath('/home/ada', '/home/ada', posix)).toBe('~')
	})

	it('keeps the separator when the middle is cut', () => {
		const deep = 'C:\\Users\\ada\\Work\\clients\\acme\\project\\leaf-folder'
		const shown = displayPath(deep, 28, 'C:\\Users\\ada', win)
		expect(shown).toBe('~\\…\\acme\\project\\leaf-folder')
		expect(shown).not.toContain('/')
		const posixShown = displayPath(
			'/home/ada/Work/clients/acme/project/leaf-folder',
			28,
			'/home/ada',
			posix,
		)
		expect(posixShown).toBe('~/…/acme/project/leaf-folder')
		expect(posixShown).not.toContain('\\')
	})

	it('gives the footer and the trust prompt the same spelling', () => {
		const cwd = 'C:\\Users\\ada\\Work\\clients\\leaf-folder'
		expect(displayPath(cwd, 80, 'C:\\Users\\ada', win)).toBe(homePath(cwd, 'C:\\Users\\ada', win))
	})
})
