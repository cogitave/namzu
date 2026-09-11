---
type: Reference
title: SQLite session storage
description: Optional native SQLite implementation of the SessionStore contract.
resource: packages/sdk/src/store/session/sqlite.ts
tags: [sdk, storage, sessions]
---

# SQLite session storage

`SqliteSessionStore` implements `SessionStore` with indexed Project, Session,
sub-session, summary and message records. It requires Node.js 22.13 or newer.
Node.js 22 may print its experimental SQLite notice.
Importing the SDK does not load SQLite; existing drivers still support Node.js 20.

```ts
import { SqliteSessionStore } from '@namzu/sdk'

const sessions = new SqliteSessionStore({
  databasePath: '/var/lib/my-agent/state/sessions.sqlite',
})
```

The host must protect the database's parent directory, including SQLite journal
files, and select the artifact paths separately. The CLI uses a private `state/`
directory and stores run artifacts directly beneath `sessions/`.

Each operation opens and closes its own connection. Writes acquire a SQLite
transaction before reading ownership versions, preventing two processes from
successfully updating the same expected version. A five-second busy timeout
bounds contention. The rollback journal and full synchronous writes commit
summaries with their session status transitions. No connection survives an
`await`, and callers do not need a shutdown hook.

Message replacement appends a replacement record. Reads project the latest
replacement and subsequent appends; older receipts remain in the database.
Original message IDs and timestamps survive reopen. Run event transcripts and
checkpoints remain the responsibility of the selected `RunStore`.

`readOnly: true` refuses writes and requires an existing initialized database.
It does not initialize schema, create directories or change journal mode.
An unknown schema version is refused. This driver does not import another
driver's filesystem format or change the SDK's default driver.
