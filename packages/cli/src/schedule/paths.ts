/**
 * Where the scheduler keeps its files: `NAMZU_HOME/schedule/`.
 *
 * ```
 * schedule/
 * ├── jobs/<job-id>.json            definition (operator-owned, CAS on revision)
 * ├── state/<job-id>.json           daemon-owned mutable state
 * ├── claims/<job-id>/<key>.json    one per occurrence ever started, published with link
 * ├── history/<job-id>.jsonl        append-only run, skip, missed and job records
 * ├── runs/<job-id>/<run-id>.json   result a fire child writes
 * ├── runs/<job-id>/<run-id>.log    the fire child's stdout and stderr
 * ├── daemon/lease.<fence>.json     single-owner lease (link-published); lease.json is a view
 * ├── daemon/endpoint.json          loopback port + token (0600)
 * ├── daemon/heartbeat.json         { at, pid, epoch, version, standby }
 * ├── daemon/log/daemon-YYYY-MM-DD.jsonl
 * ├── daemon.env                    optional KEY=value lines for fire children (0600)
 * ├── service.json                  what `schedule install` created
 * └── seen.json                     when the TUI last summarised
 * ```
 *
 * Session logs of runs live where every session lives, under
 * `projects/<slug>/` for the job's folder, so `/resume` there lists them.
 */

import { join } from 'node:path'

export interface SchedulePaths {
	readonly home: string
	readonly root: string
	readonly jobs: string
	readonly state: string
	readonly claims: string
	readonly history: string
	readonly runs: string
	readonly daemon: string
	readonly daemonLog: string
	readonly endpoint: string
	readonly heartbeat: string
	readonly service: string
	readonly seen: string
	readonly daemonEnv: string
	job(id: string): string
	stateOf(id: string): string
	claimsOf(id: string): string
	claim(id: string, key: string): string
	historyOf(id: string): string
	runsOf(id: string): string
	runResult(id: string, runId: string): string
	runLog(id: string, runId: string): string
}

export function schedulePaths(home: string): SchedulePaths {
	const root = join(home, 'schedule')
	const daemon = join(root, 'daemon')
	return {
		home,
		root,
		jobs: join(root, 'jobs'),
		state: join(root, 'state'),
		claims: join(root, 'claims'),
		history: join(root, 'history'),
		runs: join(root, 'runs'),
		daemon,
		daemonLog: join(daemon, 'log'),
		endpoint: join(daemon, 'endpoint.json'),
		heartbeat: join(daemon, 'heartbeat.json'),
		service: join(root, 'service.json'),
		seen: join(root, 'seen.json'),
		daemonEnv: join(root, 'daemon.env'),
		job: (id) => join(root, 'jobs', `${id}.json`),
		stateOf: (id) => join(root, 'state', `${id}.json`),
		claimsOf: (id) => join(root, 'claims', id),
		claim: (id, key) => join(root, 'claims', id, `${key}.json`),
		historyOf: (id) => join(root, 'history', `${id}.jsonl`),
		runsOf: (id) => join(root, 'runs', id),
		runResult: (id, runId) => join(root, 'runs', id, `${runId}.json`),
		runLog: (id, runId) => join(root, 'runs', id, `${runId}.log`),
	}
}
