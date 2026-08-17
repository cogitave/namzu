---
'@namzu/sdk': major
'@namzu/cli': patch
---

Remove the process-wide logger. A component given no logger now emits nothing instead of writing to your stderr.

**Removed from `@namzu/sdk`'s public surface:** `getRootLogger` and `configureLogger`. Both shipped `@deprecated` in an earlier minor, naming `installProcessSink` and `createLogger` as their replacements — this release is the removal that window existed for. `Logger` and `getLogCounters`, the other two exports from that module, are unchanged.

**What broke and what to do.**

`getRootLogger()` — build your own and pass it where you construct things:

```ts
import { createLogger, installProcessSink, prettySink } from '@namzu/sdk'

installProcessSink(prettySink(process.stderr), 'info')
const log = createLogger({
  sink: prettySink(process.stderr),
  level: { current: 'info' },
  resource: { 'service.name': 'my-app' },
  scope: 'my-app',
})

await query({ ...params, runConfig: { ...runConfig, logger: log } })
```

`configureLogger({ level })` — a level was only ever meaningful against a destination, and the destination is now yours. Pass the level to `installProcessSink(sink, level)`, or to `createLogger`'s `level` box, which stays live: assigning `level.current` retunes a logger already handed out.

Both take a level of type `LevelFilter` (`'debug' | 'info' | 'warn' | 'error' | 'silent'`), which is exported and unchanged.

**The behaviour change, which no type will catch.** `logger` was always optional on `RunConfig` and on every tool and component config, and omitting it used to mean "write to the process root" — in practice, your stderr, from a library, on a stream your program may be using for its own protocol. It now means `NOOP_LOGGER`: nothing is emitted, and the discard is counted, so `getLogCounters()` still tells you *N calls were thrown away* rather than *nothing happened*. If your application relied on SDK diagnostics appearing without asking for them, they will stop appearing, and the compiler will not tell you. The field names are unchanged, so passing a logger is the whole migration.

Installing a process sink no longer reroutes SDK internals on its own. It sets the destination and owns the counter set; what routes through it is the logger you build over it and hand in.

**Also exported:** `getProcessSinkCounters()`, so a host that builds its own logger can count into the process's set rather than a private one — which is what keeps `getLogCounters()` and `namzu doctor`'s `logging.pipeline` check reporting real numbers.
