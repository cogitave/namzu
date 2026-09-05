import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectId, RunId, SessionId } from '../../../types/ids/index.js'
import type { SubSessionId } from '../../../types/session/ids.js'
import {
	InvalidIdError,
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateSubSessionId,
} from '../../../utils/id.js'
import { DefaultPathBuilder } from '../path-builder.js'

const projectId = 'prj_abc' as ProjectId
const sessionId = 'ses_xyz' as SessionId
const subSessionId = 'sub_qqq' as SubSessionId
const runId = 'run_rrr' as RunId

describe('DefaultPathBuilder', () => {
	it('rootDir returns the injected root verbatim', () => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		expect(pb.rootDir()).toBe('/tmp/ns')
	})

	it('projectDir resolves to {root}/projects/{projectId}', () => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		expect(pb.projectDir(projectId)).toBe(join('/tmp/ns', 'projects', projectId))
	})

	it('sessionDir resolves to {root}/projects/{projectId}/sessions/{sessionId}', () => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		expect(pb.sessionDir(projectId, sessionId)).toBe(
			join('/tmp/ns', 'projects', projectId, 'sessions', sessionId),
		)
	})

	it('subSessionDir nests under session/subsessions/{subSessionId}', () => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		expect(pb.subSessionDir(projectId, sessionId, subSessionId)).toBe(
			join('/tmp/ns', 'projects', projectId, 'sessions', sessionId, 'subsessions', subSessionId),
		)
	})

	it('runDir nests under session/runs/{runId}', () => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		expect(pb.runDir(projectId, sessionId, runId)).toBe(
			join('/tmp/ns', 'projects', projectId, 'sessions', sessionId, 'runs', runId),
		)
	})

	it('root injection is per-instance (does not mutate global state)', () => {
		const a = new DefaultPathBuilder('/tmp/a')
		const b = new DefaultPathBuilder('/tmp/b')
		expect(a.rootDir()).toBe('/tmp/a')
		expect(b.rootDir()).toBe('/tmp/b')
		expect(a.projectDir(projectId)).not.toBe(b.projectDir(projectId))
	})

	it('preserves opaque IDs verbatim in each typed directory', () => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		const project = generateProjectId()
		const session = generateSessionId()
		const sub = generateSubSessionId()
		const run = generateRunId()
		expect(pb.runDir(project, session, run)).toBe(
			join('/tmp/ns', 'projects', project, 'sessions', session, 'runs', run),
		)
		expect(pb.subSessionDir(project, session, sub)).toBe(
			join('/tmp/ns', 'projects', project, 'sessions', session, 'subsessions', sub),
		)
	})

	it.each(['../outside', 'ses_/../../outside', 'ses_a\\outside', 'ses_a:stream', 'run_wrongKind'])(
		'refuses an unsafe or wrong-kind session ID %s before constructing a path',
		(raw) => {
			const pb = new DefaultPathBuilder('/tmp/ns')
			expect(() => pb.sessionDir(projectId, raw as SessionId)).toThrow(InvalidIdError)
			expect(() => pb.projectDir(raw as ProjectId)).toThrow(InvalidIdError)
			expect(() => pb.subSessionDir(projectId, sessionId, raw as SubSessionId)).toThrow(
				InvalidIdError,
			)
			if (raw !== 'run_wrongKind') {
				expect(() => pb.runDir(projectId, sessionId, raw as RunId)).toThrow(InvalidIdError)
			}
		},
	)
})
