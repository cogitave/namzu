// A synthetic preview service. Only observations, never these rules, reach exploration.
import { createHash } from 'node:crypto'

export const kinds = ['invoice', 'memo', 'notice']
const tag = value => createHash('sha256').update(value).digest('hex').slice(0, 6)
export function environment(seed) {
  return { root: `store-${tag(seed)}`, sealed: `sealed-${tag(`${seed}/sealed`)}`,
    aliases: Object.fromEntries(kinds.map(kind => [kind, tag(`${seed}/${kind}`)])) }
}

export function preview(config, record) {
  if (!kinds.includes(record.kind) || !/^[A-Za-z0-9-]{1,64}$/.test(record.id) ||
      !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(record.date) ||
      typeof record.sealed !== 'boolean') throw new Error('Invalid preview input.')
  const [year, month] = record.date.split('-')
  return record.sealed
    ? `${config.sealed}/${config.aliases[record.kind]}/${record.id}`
    : `${config.root}/${year}/${month}/${config.aliases[record.kind]}/${record.id}`
}

export const previewSchema = {
  type: 'object', properties: { records: { type: 'array', minItems: 1, maxItems: 8,
    items: { type: 'object', properties: {
      kind: { type: 'string', enum: kinds }, id: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' },
      date: { type: 'string', description: 'YYYY-MM-DD date.' }, sealed: { type: 'boolean' },
    }, required: ['kind', 'id', 'date', 'sealed'], additionalProperties: false },
  } }, required: ['records'], additionalProperties: false,
}

export function fixtures(seed, stage) {
  const config = environment(seed)
  return ['invoice', 'memo', 'notice', 'document', 'sum'].flatMap((family, i) =>
    [0, 1].map(trial => {
      const id = `${stage}-${family}-${trial}`
      const record = { kind: family, id: `00${tag(id)}Az`, date: `${stage === 'verification' ? 2027 : 2031}-${trial ? '11' : '03'}-19`, sealed: trial === 1 }
      const text = family === 'document' ? `Owner: ${tag(seed + id)}\n` : family === 'sum' ? '7,11,19\n' : JSON.stringify(record)
      return { id, taskId: `${stage}-${family}`, family, trial, files: { 'input.txt': text },
        prompt: family === 'document' ? 'Read input.txt and return only the Owner value.' :
          family === 'sum' ? 'Read input.txt and return only the sum of its comma-separated integers.' :
          'Read the record in input.txt. Predict the exact destination produced by this workspace preview service. Return only the path. If its behavior is unknown, return UNKNOWN.',
        expected: family === 'document' ? tag(seed + id) : family === 'sum' ? '37' : preview(config, record) }
    }))
}

// Scripted inference controls verify execution plumbing, not autonomous discovery.
export function scriptedProbes() {
  return kinds.flatMap(kind => [false, true].map(sealed => ({ kind, sealed, id: '00Az', date: '2025-02-13' })))
}
