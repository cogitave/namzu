---
type: Reference
title: Ids
description: Opaque UUID identifiers, nominal types, strict UUID admission and storage validation.
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
  Invalid values throw `InvalidIdError`; its `expectedKind` field identifies
  the rejected entity kind. The old `expectedPrefix` field is removed.
- Check an unknown value without throwing with `isEntityId(value, 'run')`.
  The second argument selects the expected entity kind.
- Deprecated `parse*Id` functions perform the same validation and throw a
  plain `Error`. Use the `as*Id` constructor in new code.

```ts
import { generateRunId, asRunId, isEntityId } from '@namzu/sdk'

const runId = generateRunId()
const restored = asRunId(runId)
const valid = isEntityId(restored, 'run')
```

Constructors accept canonical hyphenated UUIDs with an RFC variant and version
1–8, preserving their case. Prefixed strings, arbitrary names, path segments
and malformed UUIDs are rejected. Constructors never trim or rewrite keys.

`ProjectIdSchema`, `RunIdSchema` and `MessageIdSchema` use the same spelling
rules as their constructors. They remain Zod string schemas and expose their
validation patterns when converted to JSON Schema.

A UUID by itself does not establish entity kind, existence, ownership or
permission. Stores must verify the containing record and tenant, and validate
path components before using them. Validating an ID is separate from defending
against filesystem symlinks.

## Admission and upgrade

`query` and `drainQuery` require `sessionId`, `topicId`, `projectId` and
`tenantId` at runtime as well as in their TypeScript inputs. Missing, null or
empty values are rejected with `invalid_config` and `details.missingFields`
before a model call or filesystem persistence. This presence check does not
replace checked ID constructors or establish store ownership.

Only UUID entity IDs are admitted. This applies to constructors, schemas,
directory discovery and persisted record boundaries. Prefixes such as `prj_`,
`ses_`, `run_`, `cp_` and `thd_` have no compatibility path. Invalid records are
refused; initialization does not overwrite them or invent a replacement owner.
Run-state schema versions have their own field migrations, independently of ID
admission, and must still contain UUID entity IDs.

This is a major release. Hosts must generate UUIDs or supply valid UUID values
for custom entity IDs. Prefix inspection and template-literal ID types must be
replaced with nominal types and explicit entity fields. Existing prefixed state
is not read, renamed or migrated by this release. Start with a fresh dedicated
application home if retaining old state is unnecessary; changing `NAMZU_HOME`
does not delete the previous home.

## Correlation and projections

Provider-issued tool-use IDs retain their original spelling. User-question
and tool-pause requests carry those strings in `questionId`; separately minted
checkpoint IDs identify checkpoints. Match an answer using `questionId`.

Project-owned names such as agent registry keys, transport correlation IDs and
archive backend references are separate contracts; kernel entity factories do
not rename them. An emergency snapshot projected as a checkpoint retains a
deterministic ID: the UUID snapshot uses that same UUID as its checkpoint key.

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
