import { resolve } from 'node:path'

export const evidenceVersion = 2
export const normalizeAnswer = (value) => (value ?? '').trim().replace(/^['"`]|['"`]$/g, '')

// Evidence is the successful tool OUTPUT at the exact current source, not the call's name.
// A read window without the value and a matching value in another file do not establish it.
export function observesCurrentSource(tools, fixture) {
  const source = resolve(fixture.cwd, fixture.source)
  const expectedLine = `release_channel=${fixture.expected}`
  return tools.some((tool) => {
    if (tool.success === false || typeof tool.output !== 'string') return false
    if (tool.name === 'read')
      return typeof tool.input?.path === 'string' &&
        resolve(fixture.cwd, tool.input.path) === source &&
        tool.output.split('\n').some((line) => line.replace(/^\s*\d+\s+/, '').trim() === expectedLine)
    if (tool.name !== 'grep') return false
    return tool.output.split('\n').some((line) => {
      const match = /^(.*?)(?::\d+:|-\d+-)(.*)$/.exec(line)
      return match && resolve(fixture.cwd, match[1]) === source && match[2].trim() === expectedLine
    })
  })
}

export function scoreSourceObservation(run, fixture) {
  const correct = normalizeAnswer(run.output) === fixture.expected
  const observedSource = observesCurrentSource(run.toolCalls, fixture.input)
  const completed = run.stopReason === 'end_turn'
  return {
    score: Number(correct && observedSource && completed),
    reason: 'Exact answer, successful read/search output from the current source, and normal task completion.',
    details: { evidenceVersion, correct, observedSource, completed, expected: fixture.expected, observed: normalizeAnswer(run.output) },
  }
}
