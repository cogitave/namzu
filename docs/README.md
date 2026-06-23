# Namzu Documentation

Namzu is an **agent kernel** — a single-process TypeScript runtime that runs LLM agents and the
tools they call. A consumer imports one package (`@namzu/sdk`) and, in the common case, calls
one function, `query()`, which drives an agent as an async generator: each iteration calls a
model provider, reviews and executes the requested tool calls behind a verification gate and an
OS sandbox, compacts the conversation under token pressure, and checkpoints state to disk before
the next turn.

## Start here

- **[Architecture](./architecture.md)** — a code-grounded technical report on what the kernel
  does and how a single run flows through the system: packages and the dependency law, the run
  lifecycle, agents, tools, memory, persistence, safety, providers, interop, RAG, extensibility,
  observability, the applications, the engineering process, and an honest maturity assessment.

## Legacy

The previous documentation set is archived under [`./legacy/`](./legacy/). It predates the
current "agent kernel" framing and lags the manifests in places; it is kept for reference while
the docs are rebuilt from the code. Prefer [`architecture.md`](./architecture.md) as the source
of truth.
