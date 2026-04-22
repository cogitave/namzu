/**
 * Vitest `setupFiles` entry for `@namzu/sdk`.
 *
 * Silences the root logger for the entire test run. Tests that assert on
 * log output use their own mocked Logger instances (constructed via the
 * `makeLogger()` helpers colocated with each test) — those are not
 * affected by the root-level silence.
 *
 * The only thing this suppresses is the stderr spam produced by
 * production code paths that fall through to `getRootLogger()` — e.g.
 * `ToolRegistry.execute`'s zod-validation and thrown-error branches,
 * `ConnectorToolRouter.getTools`' per-instance error catch, the
 * AgentBus listener-throw handler, and every connector's `connect()`
 * info log. GitHub Actions annotates any `[ERROR]` stderr line as a
 * workflow error; silencing the root logger during tests keeps the CI
 * log clean.
 *
 * This is test-only configuration. It runs before every test file and
 * does not affect consumers.
 */

import { configureLogger } from './utils/logger.js'

configureLogger({ level: 'silent' })
