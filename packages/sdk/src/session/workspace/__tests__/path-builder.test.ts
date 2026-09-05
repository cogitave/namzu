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

const projectId = '9f6c23c5-cd00-407a-819b-cfb06d4f9071' as ProjectId
const sessionId = '1927fccc-df29-46b4-a1c9-6366075a3bbc' as SessionId
const subSessionId = '5da75299-8755-452c-b4ae-6a38f4d721d0' as SubSessionId
const runId = 'fb9b0d37-48be-423e-be29-35bfd2ba94bd' as RunId

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

	it.each([
		'../outside',
		'ses_/../../outside',
		'1aa5bf90-15f2-4704-97fc-8df4943e1e3d\\outside',
		'1aa5bf90-15f2-4704-97fc-8df4943e1e3d:stream',
		'run_unsupported_identifier',
	])('refuses an unsafe or prefixed entity ID %s before constructing a path', (raw) => {
		const pb = new DefaultPathBuilder('/tmp/ns')
		expect(() => pb.sessionDir(projectId, raw as SessionId)).toThrow(InvalidIdError)
		expect(() => pb.projectDir(raw as ProjectId)).toThrow(InvalidIdError)
		expect(() => pb.subSessionDir(projectId, sessionId, raw as SubSessionId)).toThrow(
			InvalidIdError,
		)
		expect(() => pb.runDir(projectId, sessionId, raw as RunId)).toThrow(InvalidIdError)
	})
})
