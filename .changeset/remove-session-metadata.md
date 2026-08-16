---
'@namzu/sdk': major
---

Removed the exported type `SessionMetadata`. It was an alias of `RunStateMetadata` with no producer, no reader and no runtime effect anywhere in the workspace — `grep` found exactly two hits, the declaration and its own entry in the public-surface baseline.

If you referenced it, use `RunStateMetadata`, which is what it always resolved to.

It goes straight to `major` without a deprecation release because there is nothing to migrate: a deprecation window exists so working code has a version where it still compiles and warns, and no working code can be built against a type that describes a shape nothing produces. It is removed rather than kept because the name was actively misleading — a reader looking for the fields that describe a Session (`topicId`, `currentActor`, `previousActors`, `ownerVersion`, all of which live on the Session entity) found this export and was handed a run's metadata instead. No replacement is introduced: nothing in the tree reserves the phrase for a distinct shape, so a stand-in would be a new undriven name filling an export slot.
