# @namzu/decision

## 0.2.0

### Minor Changes

- a8a751a: New package `@namzu/decision`: a provider-agnostic interface for System-1 decision models (fast, non-generative models that return a yes/no probability, a choice with per-option probabilities, or a score), with an Azure AI Foundry Microsoft-Decision-1 driver. Nothing to do to upgrade; this is a new, dependency-free package. Yes/no is verified against the live API; the choice and score request shapes are provisional.
