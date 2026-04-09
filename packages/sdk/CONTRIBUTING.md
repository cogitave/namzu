# Contributing to Namzu SDK

Thank you for your interest in contributing to Namzu! Every contribution matters — whether it's a bug report, a feature idea, documentation improvement, or code.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/namzu-sdk.git
   cd namzu-sdk
   ```
3. Install dependencies:
   ```bash
   pnpm install
   ```
4. Create a branch:
   ```bash
   git checkout -b feat/your-feature
   ```

## Development

```bash
pnpm build        # Build the project
pnpm dev          # Watch mode
pnpm test         # Run tests
```

### Code Style

- TypeScript strict mode is enforced
- Use tabs for indentation
- Follow existing patterns in the codebase
- Use branded IDs for resource identifiers (see `src/types/ids/`)
- Use `defineTool()` for tool definitions
- Use Zod for runtime validation schemas

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new chunking strategy
fix: resolve MCP transport reconnection issue
docs: update RAG pipeline examples
refactor: simplify tool registry activation logic
test: add unit tests for persona merging
```

## Pull Requests

1. Keep PRs focused — one feature or fix per PR
2. Update documentation if your change affects the public API
3. Add or update tests for your changes
4. Ensure CI passes (`pnpm build` and `pnpm test`)
5. Fill out the PR template

## Reporting Bugs

Use the [bug report template](https://github.com/Cogitave/namzu/issues/new?template=bug_report.yml) and include:

- Steps to reproduce
- Expected vs actual behavior
- Environment (Node.js version, OS, SDK version)

## Suggesting Features

Use the [feature request template](https://github.com/Cogitave/namzu/issues/new?template=feature_request.yml). Explain the problem you're trying to solve, not just the solution you have in mind.

## Security

Found a vulnerability? **Do not open a public issue.** See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the same [FSL-1.1-MIT](./LICENSE.md) license that covers the project.
