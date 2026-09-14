import { createHash } from 'node:crypto'
import { kinds, previewSchema } from './autonomous-environment.mjs'

export { previewSchema }
const tag = value => createHash('sha256').update(value).digest('hex').slice(0, 8)
export const families = ['month', 'day', 'year', 'identity', 'kind']
export const baselinePolicy = 'Investigate the undocumented preview service through the provided tool. Choose your own experiments to distinguish possible rules. Use observed results to revise hypotheses. Do not claim rules you have not checked. Finish when you have enough evidence, or identify remaining uncertainty.'
export function configuration(seed, family) {
  if (!families.includes(family)) throw new Error('Unknown environment family.')
  return { family, root: tag(seed), sealed: tag(`${seed}/sealed`), aliases: Object.fromEntries(kinds.map(k => [k, tag(`${seed}/${k}`)])) }
}
export function preview(config, r) {
  if (!kinds.includes(r.kind) || !/^[A-Za-z0-9-]{1,64}$/.test(r.id) || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(r.date) || typeof r.sealed !== 'boolean') throw new Error('Invalid preview input.')
  if (config.family === 'identity') return `${config.root}/${r.id}`
  if (config.family === 'kind') return `${config.root}/${config.aliases[r.kind]}/${r.id}`
  const date = r.date.split('-').slice(0, { year: 1, month: 2, day: 3 }[config.family]).join('/')
  return r.sealed ? `${config.sealed}/${config.aliases[r.kind]}/${r.id}` : `${config.root}/${date}/${config.aliases[r.kind]}/${r.id}`
}
export function episode(seed, stage, family, trial) {
  const key = `${stage}-${family}-${trial}`, config = configuration(`${seed}/${key}`, family)
  const tests = Array.from({ length: 6 }, (_, i) => ({ kind: kinds[i % 3], id: `00${tag(`${seed}/${key}/${i}`)}Az`, date: `${2034 + trial}-${i % 2 ? '11' : '02'}-${i < 3 ? '17' : '23'}`, sealed: i >= 3 }))
  return { id: key, taskId: `${stage}-${family}`, family, trial, config, tests, expected: tests.map(r => preview(config, r)) }
}
export function suite(seed, stage) { return families.flatMap(family => [0, 1].map(trial => episode(seed, stage, family, trial))) }
export function controlProbes() {
  return kinds.flatMap(kind => [false, true].map(sealed => ({ kind, sealed, id: '00ProbeAz', date: '2029-03-17' })))
}
