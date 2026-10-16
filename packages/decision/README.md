<!-- okf
type: Reference
title: "@namzu/decision"
description: >-
  Provider-agnostic System-1 decision models: fast, non-generative yes/no,
  choice and score decisions with typed probabilities.
tags: [readme, package, decision]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-16T00:00:00Z }
-->

# @namzu/decision

A System-1 decision model is a fast, non-generative model that returns a typed
decision instead of text: a yes/no probability, a choice with per-option
probabilities, or a score. This package puts them behind one `DecisionModel`
interface. It has no runtime dependencies.

## Install

```bash
pnpm add @namzu/decision
```

## Usage

```ts
import { AzureFoundryDecisionModel } from '@namzu/decision'

const model = new AzureFoundryDecisionModel({
  endpoint: 'https://my-resource.services.ai.azure.com',
  deployment: 'decision-1',
  getToken: async () => entraToken(), // you supply the Entra bearer token
})

const { p } = await model.yesno('The build is red.', 'Should we page the owner?')
```

## Status

`yesno` is verified against the live Azure AI Foundry API. The request shapes
for `choice` and `score` are provisional until confirmed against the Foundry
schema.

## Documentation

See [Decision models](../../docs/sdk/decision.md).
