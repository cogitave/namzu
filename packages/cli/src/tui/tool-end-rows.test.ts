import { expect, it } from 'vitest'

import { withoutErrorName } from './tool-end-rows.js'

it('drops the interpreter error name in front of a failure sentence, once or doubled', () => {
	expect(withoutErrorName('Error: The script stopped at line 3, column 20: it broke')).toBe(
		'The script stopped at line 3, column 20: it broke',
	)
	expect(withoutErrorName('Error: TypeError: cannot read property of undefined')).toBe(
		'cannot read property of undefined',
	)
	expect(withoutErrorName('No error name here: just text')).toBe('No error name here: just text')
	expect(withoutErrorName('Errors are not names')).toBe('Errors are not names')
})
