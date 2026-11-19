import { describe, expect, it } from 'vitest'
import {
	addressText,
	cleanPath,
	fileAllowed,
	fileUrl,
	isInside,
	pathOfFileUrl,
	resolveAddress,
} from './browser-address.js'

const win = { workFolder: 'C:\\Users\\me\\work', caseless: true }
const posix = { workFolder: '/home/me/work', caseless: false }

describe('paths', () => {
	it('resolves dots and slashes', () => {
		expect(cleanPath('C:\\a\\b\\..\\c\\.\\d')).toBe('C:/a/c/d')
		expect(cleanPath('/a//b/../c/')).toBe('/a/c')
		expect(cleanPath('C:\\')).toBe('C:/')
	})
	it('knows inside from beside', () => {
		expect(isInside('/home/me/work', '/home/me/work/a/b.html', false)).toBe(true)
		expect(isInside('/home/me/work', '/home/me/work', false)).toBe(true)
		expect(isInside('/home/me/work', '/home/me/work-two/a.html', false)).toBe(false)
		expect(isInside('/home/me/work', '/home/me/work/../x.html', false)).toBe(false)
		expect(isInside('C:/Users/me/work', 'c:/users/me/WORK/a.html', true)).toBe(true)
		expect(isInside('C:/Users/me/work', 'c:/users/me/WORK/a.html', false)).toBe(false)
	})
	it('round trips a file address, with spaces and a drive', () => {
		const url = fileUrl('C:\\Users\\me\\my work\\index.html')
		expect(url).toBe('file:///C:/Users/me/my%20work/index.html')
		expect(pathOfFileUrl(url)).toBe('C:/Users/me/my work/index.html')
		expect(pathOfFileUrl(fileUrl('/home/me/a b.html'))).toBe('/home/me/a b.html')
	})
	it('shows the whole local path in the bar', () => {
		expect(addressText('file:///C:/Users/me/work/index.html')).toBe('C:/Users/me/work/index.html')
		expect(addressText('https://example.com/a')).toBe('https://example.com/a')
		expect(addressText('about:blank')).toBe('')
	})
})

describe('resolveAddress', () => {
	it('opens a file inside the work folder', () => {
		expect(resolveAddress('C:\\Users\\me\\work\\site\\index.html', win)).toEqual({
			ok: true,
			url: 'file:///C:/Users/me/work/site/index.html',
		})
		expect(resolveAddress('file:///home/me/work/a.html', posix)).toEqual({
			ok: true,
			url: 'file:///home/me/work/a.html',
		})
	})
	it('refuses a file outside it, however it is spelled', () => {
		for (const text of [
			'C:\\Users\\me\\.ssh\\id_rsa',
			'C:\\Users\\me\\work\\..\\secret.html',
			'file:///C:/Windows/win.ini',
			'/etc/passwd',
		])
			expect(resolveAddress(text, win).ok).toBe(false)
		expect(resolveAddress('/home/me/work/../.ssh/key', posix).ok).toBe(false)
		expect(resolveAddress('file:///home/me/work/../x', posix).ok).toBe(false)
	})
	it('refuses every file when there is no work folder', () => {
		expect(resolveAddress('/tmp/a.html', { workFolder: undefined, caseless: false }).ok).toBe(false)
	})
	it('reads a relative path only when told it came from a turn', () => {
		expect(resolveAddress('site/index.html', posix).ok).toBe(false)
		expect(resolveAddress('site/index.html', posix, { relative: true })).toEqual({
			ok: true,
			url: 'file:///home/me/work/site/index.html',
		})
		expect(resolveAddress('../x.html', posix, { relative: true }).ok).toBe(false)
	})
	it('opens http and https, and adds https to a bare host', () => {
		expect(resolveAddress('http://localhost:3000/a', posix)).toEqual({
			ok: true,
			url: 'http://localhost:3000/a',
		})
		expect(resolveAddress('example.com/x', posix)).toEqual({
			ok: true,
			url: 'https://example.com/x',
		})
		expect(resolveAddress('localhost:8080', posix).ok).toBe(true)
	})
	it('refuses other kinds and plain words', () => {
		for (const text of [
			'javascript:alert(1)',
			'data:text/html,hi',
			'ftp://a.b/c',
			'blob:x',
			'hello world',
			'',
			'chrome://gpu',
		])
			expect(resolveAddress(text, posix).ok).toBe(false)
	})
	it('checks a subresource with the same rule', () => {
		expect(fileAllowed('file:///home/me/work/a.css', posix)).toBe(true)
		expect(fileAllowed('file:///home/me/other/a.css', posix)).toBe(false)
		expect(fileAllowed('https://a.b/c.css', posix)).toBe(false)
	})
})
