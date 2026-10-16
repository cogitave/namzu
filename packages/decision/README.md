<!-- okf
type: Reference
title: "@namzu/decision"
description: >-
  Provider-agnostic System-1 decision models: fast, non-generative yes/no,
  choice and score decisions with typed probabilities, and the fail-open
  `decide` tool that puts them in front of an agent.
tags: [readme, package, decision]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-16T00:00:00Z }
-->

# @namzu/decision

A System-1 decision model is a fast, non-generative model that returns a typed
decision instead of text: a yes/no probability, a choice with per-option
probabilities, or a score. This package puts them behind one `DecisionModel`
interface, ships the drivers that answer (Azure AI Foundry; a generic HTTP
endpoint for local/self-hosted models), and owns the agent-facing behaviour —
the optional, advisory, **fail-open** `decide` tool.

It is an internal, **private** package: it is bundled into `@namzu/cli` and is
never published to npm.

## Usage

```ts
import { createDecisionModel, createDecisionTool } from '@namzu/decision'

// Pick a driver by provider. Azure AI Foundry takes a host-supplied Entra
// bearer via `getToken` (no Azure SDK dependency); the HTTP driver speaks the
// same wire to a local or self-hosted server and is keyless by default.
const model = createDecisionModel({
  provider: 'azure',
  endpoint: 'https://my-resource.services.ai.azure.com',
  deployment: 'decision-1',
  getToken: async () => process.env.AZURE_FOUNDRY_TOKEN ?? '',
})

const { p } = await model.yesno('The build is red.', 'Should we page the owner?')

// Or hand it to an agent as one optional tool. A host that configures no
// decision model simply does not create it, so the agent never sees it.
const decide = createDecisionTool(model)
```

## Fail-open

`createDecisionTool` never turns a model outage into a tool failure. A network
error, a rate limit or a 4xx comes back as a successful result that tells the
agent the model is unavailable and to decide with its own reasoning. The
decision model is always advisory; code and the agent remain the authority on
hard constraints.

## Status

`yesno` is verified against the live Azure AI Foundry API and is well
calibrated. The request shapes for `choice` and `score` are **provisional**:
the live service rejects every field name tried for the options/levels and the
schema is not yet published, so both are exposed but fail open until the wire
is confirmed.

## Documentation

See [Decision models](../../docs/sdk/decision.md).
