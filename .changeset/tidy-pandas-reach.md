---
'@namzu/bedrock': minor
---

Refuses a model id this driver's wire cannot serve, instead of letting AWS
answer with a validation error that names neither the cause nor the fix.

This driver speaks Bedrock's `Converse` API, which serves ARN-versioned model
ids — `us.anthropic.claude-sonnet-4-5-20250929-v1:0` and friends, the
integration documented for Claude 4.6 and earlier.

The current generation is not on that wire. Claude Opus 5, Sonnet 5, Fable 5,
Opus 4.8 and Opus 4.7 are served by a different Bedrock integration that speaks
the Messages API shape, and their ids carry no version suffix at all
(`anthropic.claude-opus-5`). The vendor's own legacy page gives the reason they
are absent from its model table: they have no ARN-versioned ids.

Passing one here now throws before any AWS call, naming both what this wire
serves and where the newer models live.

It is a check on the id SHAPE, not a model list. An unrecognised but versioned
id passes untouched, and non-Claude models are not policed at all — a list that
has to be edited for every new model is wrong before anyone reads it.

Reaching the newer models needs a driver built for that endpoint. That is not
in this release, and guessing at a wire is how a driver ends up confidently
wrong; the reachability refusal is correct and complete on its own.
