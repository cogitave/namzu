# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-09

### Added

- Reactive, Pipeline, Router, and Supervisor agent patterns
- Tool system with `defineTool()`, progressive disclosure, and built-in tools (bash, read-file, write-file, glob, search-tools)
- OpenRouter and AWS Bedrock provider implementations
- Full RAG pipeline: chunking (fixed, sentence, paragraph, recursive), embedding, in-memory vector store, retrieval, knowledge base
- Connector framework: HTTP, webhook, and MCP (stdio + HTTP-SSE transports)
- MCP client and server with bidirectional tool bridging
- A2A protocol support: agent cards, message conversion, event mapping
- SSE streaming with 28 event types
- Persona system with inheritance and layer-based prompt assembly
- Skills system with progressive disclosure and inheritance chains
- Human-in-the-loop: plan review, tool approval, checkpoint/resume
- Thread/Run separation for clean conversation history
- Multi-tenant isolation: scoped registries, tenant connector manager
- In-memory and disk-backed stores for runs, tasks, conversations, activities
- OpenTelemetry integration for tracing and metrics
- Credential vault abstraction
- Branded ID system for type-safe resource identifiers
- Zod-based configuration schemas

[0.1.0]: https://github.com/Cogitave/namzu/releases/tag/v0.1.0
