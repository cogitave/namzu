---
type: Reference
title: Ids
description: Opaque UUID identifiers, nominal types, compatible legacy records, and storage validation.
resource: packages/sdk/src/utils/id.ts
tags: [sdk, ids, storage]
status: stable
---

# Ids

Kernel factories such as `generateProjectId()`, `generateSessionId()` and
`generateRunId()` mint UUID v4 strings. Entity type is carried by a nominal
TypeScript brand and by the record's schema and location. A Session ID cannot
be passed where a Run ID is required without explicitly bypassing the type
system. The serialized UUID does not encode its entity type.

## Minting and checking

- Mint with the factory for the entity, such as `generateRunId()`.
- Check an external string with `asRunId(value)` or the matching constructor.
  Invalid values throw `InvalidIdError`.
- Check an unknown value without throwing with `isEntityId(value, 'run')`.
  The second argument selects the expected entity kind.
- Deprecated `parse*Id` functions perform the same validation and throw a
  plain `Error`. Use the `as*Id` constructor in new code.

```ts
import { generateRunId, asRunId, isEntityId } from '@namzu/sdk'

const runId = generateRunId()
const restored = asRunId(runId)
const legacy = asRunId('run_existing-A_1')
const valid = isEntityId(restored, 'run')
```

Constructors accept canonical hyphenated UUIDs with an RFC variant and version
1–8, preserving their case. They also accept the matching established prefix
followed by a nonempty `[A-Za-z0-9_-]+` suffix. For example,
`run_existing-A_1` remains valid as a Run ID, while `ses_existing` does not.
Empty suffixes, separators, whitespace, periods, colons and Unicode suffixes
are rejected. Constructors never trim, lowercase or rewrite identifiers.

`ProjectIdSchema`, `RunIdSchema` and `MessageIdSchema` use the same spelling
rules as their constructors. They remain Zod string schemas and expose their
validation patterns when converted to JSON Schema.

A UUID by itself does not establish entity kind, existence, ownership or
permission. Stores must verify the containing record and tenant, and validate
path components before using them. Validating an ID is separate from defending
against filesystem symlinks.

## Existing records

Existing safe prefixed IDs remain unchanged. New and old IDs can coexist in
one project hierarchy, including child runs, checkpoints, tasks and memory.
Directory discovery accepts both formats. No startup rename or rewrite is
performed, so references keep their original keys.

The retired, ambiguous `thd_` container format remains unsupported. Records
written with it need an older migration-capable Namzu release before this
version can read them. Run-state schema versions still have their own explicit
field migrations; changing a schema field does not justify guessing an ID's
meaning.

Older constructors accepted arbitrary suffixes after a prefix. Data containing
unsafe custom IDs needs to be exported with the previous SDK and remapped
along with every referring record before upgrading. Do not sanitize IDs
independently: different values can collapse to the same key.

This factory-default change is a major release. Callers that parse prefixes,
validate only prefixed strings, or depend on template-literal ID types must
switch to constructors, nominal entity types and explicit schema fields before
accepting new records. Do not downgrade a store containing UUID records to a
reader that recognizes only prefixes.

## Correlation and projections

Provider-issued tool-use IDs retain their original spelling. User-question
and tool-pause requests carry those strings in `questionId`; separately minted
checkpoint IDs identify checkpoints. Match an answer using `questionId`.

Project-owned names such as agent registry keys, transport correlation IDs and
archive backend references are separate contracts; kernel entity factories do
not rename them. An emergency snapshot projected as a checkpoint retains a
deterministic ID: existing `esave_` snapshots keep their legacy checkpoint
mapping, while a UUID snapshot uses that same UUID as its checkpoint key.

## Reusing an existing identity

`CreateSessionParams.id` lets a host choose a Session ID before persisting the
conversation. The store refuses an ID it already holds. The CLI uses this so
hooks, logs and the first stored message all refer to the same conversation.

`new InMemorySessionStore(projects)` accepts an optional array of existing
`Project` snapshots. `new InMemoryTopicStore(topics)` similarly accepts `Topic`
snapshots. Both clone their inputs, validate IDs and reject duplicate IDs.
Project roots are canonicalized and remain unique within a tenant. Status,
limits, timestamps and ownership versions are preserved; hydration creates no
replacement IDs. Topic and TopicStatus are exported types.

These constructors populate in-memory views; they do not copy durable
conversations or grant permission to reopen an archived project. Hosts remain
responsible for loading authoritative metadata and enforcing its lifecycle.

## Installation identity

The CLI mints one tenant per installation in `~/.namzu/identity.json` and one
CLI Topic per Project. Opening a conversation or spawning a child does not
mint another Project. See [Project and session state](../cli/project-state.md).
