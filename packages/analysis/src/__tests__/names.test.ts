import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

const trees: Tree[] = []
const make = (files: Record<string, string | Uint8Array> = {}) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const CALLS = `import { helper } from './x.js';
import * as ns from './y.js';
function target() {}
target();
this.target();
obj.target();
obj[ 'target' ]();
target.call(null);
target.apply(null, []);
target.bind(null);
(0, ns.helper)();
(0, helper)();
tag\`x\`;
`

describe('callee text is normalised', () => {
	it('reads (0, ns.helper)() and (0, helper)() as calls of helper', async () => {
		const tree = make({ 'calls.js': CALLS })
		const p = provider()
		const r = ok(
			await p.callersOf({
				root: tree.root,
				name: 'helper',
				match: 'member',
				path: tree.path('calls.js'),
			}),
		)
		expect(r.value.items.map((i) => [i.line, i.callee])).toEqual([
			[11, 'ns.helper'],
			[12, 'helper'],
		])
		await p.dispose()
	})

	it('reads obj["lit"]() as obj.lit(), and lists .call/.apply/.bind and tagged templates', async () => {
		const tree = make({ 'calls.js': CALLS })
		const p = provider()
		const root = tree.root
		const path = tree.path('calls.js')
		const member = ok(await p.callersOf({ root, name: 'target', match: 'member', path }))
		const lines = member.value.items.map((i) => `${i.line}:${i.kind}:${i.callee}`)
		expect(lines).toContain('4:call:target')
		expect(lines).toContain('6:call:obj.target')
		expect(lines).toContain('7:call:obj.target')
		expect(lines).toContain('8:call-via:target')
		expect(lines).toContain('9:call-via:target')
		expect(lines).toContain('10:call-via:target')
		const tagged = ok(await p.callersOf({ root, name: 'tag', path }))
		expect(tagged.value.items.map((i) => [i.line, i.kind])).toEqual([[13, 'tagged']])
		await p.dispose()
	})

	it('counts the calls it cannot name instead of claiming to have seen them all', async () => {
		const tree = make({
			'a.js': 'function f(){}\nf();\nconst fns = [f];\nfns[0]();\n(await load())();\n',
		})
		const p = provider()
		const r = ok(await p.callersOf({ root: tree.root, name: 'f', path: tree.path('a.js') }))
		expect(r.value.total).toBe(1)
		expect(r.evidence.observed.join(' ')).toContain('2 of 4 calls in scope use a computed callee')
		// 2 of 4 is far over 5 %.
		expect(r.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(r.evidence.coverage)).toContain(
			'2 of 4 calls in scope use a computed callee',
		)
		await p.dispose()
	})

	it('states 0 computed callees and stays complete when every callee is named', async () => {
		const tree = make({ 'a.js': 'function f(){}\nf();\n' })
		const p = provider()
		const r = ok(await p.callersOf({ root: tree.root, name: 'f', path: tree.path('a.js') }))
		expect(r.evidence.observed.join(' ')).toContain('0 of 1 calls in scope use a computed callee')
		expect(r.evidence.coverage.status).toBe('complete')
		await p.dispose()
	})
})

const SVC = `export class Svc {
  constructor(dep) { this.init(); }
  init() { return helper("init-marker"); }
  get value() { return 1; }
  static async load(id) { return fetchIt("load-marker" + id); }
  arrowProp = () => this.init();
  static { setup("static-block-marker"); }
  field = compute("field-init-marker");
}
var Z = class { meth() { return "zmeth"; } };
var Y = class extends Z { meth() { return super.meth() + "ymeth"; } };
const obj = { run() { return "obj-run"; }, other: () => 1 };
module.exports = { go() { return 1; } };
function outer() { function inner() { return 1; } return inner; }
`

describe('methods are qualified by what holds them', () => {
	it('names a class method Svc.init and still answers to init', async () => {
		const tree = make({ 'svc.js': SVC })
		const p = provider()
		const root = tree.root
		const path = tree.path('svc.js')
		const q = ok(await p.functionSource({ root, path, name: 'Svc.init' }))
		expect(q.value.total).toBe(1)
		expect(q.value.items[0]?.function.qualifiedName).toBe('Svc.init')
		expect(q.value.items[0]?.function.name).toBe('init')
		expect(ok(await p.functionSource({ root, path, name: 'init' })).value.total).toBe(1)
		for (const name of ['Svc.constructor', 'Svc.value', 'Svc.load', 'Svc.arrowProp']) {
			expect(ok(await p.functionSource({ root, path, name })).value.total, name).toBe(1)
		}
		await p.dispose()
	})

	it('separates two classes that both have meth, taking the variable as a class expression name', async () => {
		const tree = make({ 'svc.js': SVC })
		const p = provider()
		const root = tree.root
		const path = tree.path('svc.js')
		const both = ok(await p.functionSource({ root, path, name: 'meth' }))
		expect(both.value.total).toBe(2)
		const y = ok(await p.functionSource({ root, path, name: 'Y.meth' }))
		expect(y.value.total).toBe(1)
		expect(y.value.items[0]?.source.text).toContain('ymeth')
		const z = ok(await p.functionSource({ root, path, name: 'Z.meth' }))
		expect(z.value.items[0]?.source.text).toContain('zmeth')
		await p.dispose()
	})

	it('qualifies object-literal methods by the object, and leaves nested functions bare', async () => {
		const tree = make({ 'svc.js': SVC })
		const p = provider()
		const root = tree.root
		const path = tree.path('svc.js')
		expect(ok(await p.functionSource({ root, path, name: 'obj.run' })).value.total).toBe(1)
		expect(ok(await p.functionSource({ root, path, name: 'obj.other' })).value.total).toBe(1)
		expect(ok(await p.functionSource({ root, path, name: 'module.exports.go' })).value.total).toBe(
			1,
		)
		const inner = ok(await p.functionSource({ root, path, name: 'inner' }))
		expect(inner.value.items[0]?.function.qualifiedName).toBeUndefined()
		await p.dispose()
	})

	it('finds this.m() inside the class as resolved and other receivers as text-only', async () => {
		const tree = make({
			'svc.js': SVC,
			'use.js': 'function go(s) { s.init(); other.init(); }\n',
			'unrelated.js': 'class Other { init() {} run() { this.init(); } }\n',
		})
		const p = provider()
		const root = tree.root
		const r = ok(await p.callersOf({ root, name: 'Svc.init', scope: 'workspace' }))
		const resolved = r.value.items.filter((i) => i.resolution === 'resolved')
		const text = r.value.items.filter((i) => i.resolution === 'text-only')
		// this.init() in the constructor and in the arrow field: both inside Svc.
		expect(resolved.map((i) => i.path.split('/').pop())).toEqual(['svc.js', 'svc.js'])
		expect(text.map((i) => i.path.split('/').pop()).sort()).toEqual([
			'unrelated.js',
			'use.js',
			'use.js',
		])
		// Resolved come first.
		expect(r.value.items.slice(0, 2).every((i) => i.resolution === 'resolved')).toBe(true)
		expect(r.evidence.observed.join(' ')).toContain('2 resolved')
		expect(r.evidence.observed.join(' ')).toContain('3 text-only')
		await p.dispose()
	})

	it('describes a position in a class body outside every method', async () => {
		const tree = make({ 'svc.js': SVC })
		const p = provider()
		const r = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('svc.js'),
				line: 7,
				column: 14,
			}),
		)
		expect(r.value.function).toBeNull()
		expect(r.value.inClass).toBe('Svc')
		expect(r.evidence.observed.join(' ')).toContain('body of class Svc')
		expect(r.evidence.observed.join(' ')).not.toContain('top level of the file')
		const top = ok(
			await p.enclosingFunction({ root: tree.root, path: tree.path('svc.js'), line: 1, column: 1 }),
		)
		expect(top.evidence.observed.join(' ')).toContain('top level of the file')
		await p.dispose()
	})
})

describe('export and require forms', () => {
	const IMP = `import type { A } from './types';
import fs = require('node:fs');
export type { A };
export { c as renamed };
export const { d1, d2: renamedD, ...restD } = obj;
export const [e1, [e2]] = arr;
export const f1 = 1, f2 = 2;
export class K {}
export interface Ifc {}
export type Tp = string;
export function fn1() {}
export default class {}
export = something;
`
	const CJS = `const a = require('./a'), {b, c: cc} = require('./b');
const d = require('./d').pick;
module.exports = { a, b };
module.exports.c = function() {};
exports.d = 1;
Object.defineProperty(exports, 'e', { get() { return 1 } });
Object.defineProperty(exports, '__esModule', { value: true });
`

	it('lists destructured, type-only and export = forms of an ES module', async () => {
		const tree = make({ 'imp.ts': IMP })
		const p = provider()
		const r = ok(await p.imports({ root: tree.root, path: tree.path('imp.ts') }))
		const exp = r.value.items
			.filter((e) => e.direction === 'export')
			.map((e) => `${e.kind}:${e.name}`)
		expect(exp).toEqual(
			expect.arrayContaining([
				'type:A',
				'named:renamed',
				'named:d1',
				'named:renamedD',
				'named:restD',
				'named:e1',
				'named:e2',
				'named:f1',
				'named:f2',
				'named:K',
				'type:Ifc',
				'type:Tp',
				'named:fn1',
				'default:default',
				'assign:export =',
			]),
		)
		const imp = r.value.items.filter((e) => e.direction === 'import')
		expect(imp.find((e) => e.kind === 'require')?.names).toEqual(['* as fs'])
		await p.dispose()
	})

	it('lists CommonJS exports and what a require binds', async () => {
		const tree = make({ 'cjs.js': CJS })
		const p = provider()
		const r = ok(await p.imports({ root: tree.root, path: tree.path('cjs.js') }))
		const exp = r.value.items
			.filter((e) => e.direction === 'export')
			.map((e) => `${e.kind}:${e.name}`)
		expect(exp).toEqual(
			expect.arrayContaining([
				'commonjs:module.exports',
				'commonjs:a',
				'commonjs:b',
				'commonjs:c',
				'commonjs:d',
				'commonjs:e',
			]),
		)
		expect(exp).not.toContain('commonjs:__esModule')
		const names = r.value.items
			.filter((e) => e.direction === 'import')
			.map((e) => (e.direction === 'import' ? [e.source, e.names.join('+')] : []))
		expect(names).toEqual(
			expect.arrayContaining([
				['./a', '* as a'],
				['./b', 'b+c as cc'],
				['./d', 'pick'],
			]),
		)
		await p.dispose()
	})
})

describe('long literals', () => {
	const far = `${'A'.repeat(5000)}FAR_NEEDLE${'B'.repeat(2000)}`
	const huge = `HEAD_NEEDLE${'x'.repeat(20000)}MIDDLE_NEEDLE${'y'.repeat(20000)}TAIL_NEEDLE`

	it('keeps whole a literal up to twice the head, so FAR_NEEDLE at 5000 is found', async () => {
		const tree = make({ 'a.js': `function f() { return "${far}" }\n` })
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'FAR_NEEDLE' }))
		expect(r.value.total).toBe(1)
		expect(r.value.items[0]?.value).toContain('FAR_NEEDLE')
		await p.dispose()
	})

	it('keeps the head and the tail of a longer one, and says the middle is not searchable', async () => {
		const tree = make({ 'a.js': `function f() { return "${huge}" }\n` })
		const p = provider()
		const root = tree.root
		expect(ok(await p.findLiteral({ root, text: 'HEAD_NEEDLE' })).value.total).toBe(1)
		const tail = ok(await p.findLiteral({ root, text: 'TAIL_NEEDLE' }))
		expect(tail.value.total).toBe(1)
		// The preview is the window around the match, not the first 200 characters.
		expect(tail.value.items[0]?.value).toContain('TAIL_NEEDLE')
		const middle = ok(await p.findLiteral({ root, text: 'MIDDLE_NEEDLE' }))
		expect(middle.value.total).toBe(0)
		expect(middle.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(middle.evidence.coverage)).toContain(
			'1 literal(s) in scope are longer than 8192',
		)
		// The two ends are not joined into a match.
		expect(ok(await p.findLiteral({ root, text: 'xyyy' })).value.total).toBe(0)
		await p.dispose()
	})
})

describe('NUL in a search', () => {
	it('searches text with a NUL between other characters', async () => {
		const tree = make({
			'a.js': 'function f() { return "a\\u0000b" }\nfunction g() { return "ab" }\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'a\u0000b' }))
		expect(r.value.total).toBe(1)
		await p.dispose()
	})
})
