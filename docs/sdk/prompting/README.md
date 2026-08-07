---
title: Skills and Personas
description: Compose Namzu system prompts from personas, skill files, and session context using the public @namzu/sdk prompt surfaces.
last_updated: 2026-08-07
status: current
related_packages: ["@namzu/sdk"]
---

# Skills and Personas

Prompt composition in `@namzu/sdk` is intentionally split into reusable parts instead of one giant string. Personas capture stable behavioral shape. Skills capture reusable instructions from disk. Session context injects run-specific detail late.

## 1. The Prompt Layers

The public prompt-building surfaces map to three different responsibilities:

| Surface | Owns | Main exports |
| --- | --- | --- |
| Persona | identity, expertise, constraints, output style | `mergePersonas`, `withSessionContext`, persona types |
| Skill | reusable instruction files with frontmatter | `SkillRegistry`, `discoverSkills`, `loadSkill`, `resolveSkillChain`, `parseFrontmatter` |
| Prompt assembly | final system prompt text | `assembleSystemPrompt` |

This separation matters because the runtime treats stable and dynamic prompt parts differently.

## 2. Build a Persona in Code

This example is fully local and does not depend on a provider package:

```ts
import {
  assembleSystemPrompt,
  mergePersonas,
  withSessionContext,
} from '@namzu/sdk'

const basePersona = {
  identity: {
    role: 'Technical documentation engineer',
    description: 'Explain SDK behavior clearly and prefer concrete examples.',
  },
  expertise: {
    domains: ['TypeScript SDKs', 'LLM runtime design', 'developer docs'],
  },
  reflexes: {
    constraints: [
      'Use precise naming from the public API.',
      'Do not invent unpublished packages or local-only flows.',
    ],
    toolGuidance: 'Use tools only when direct code inspection is needed.',
    outputDiscipline: {
      betweenToolCalls: 'minimal',
      suppressInnerMonologue: true,
      finalResponse: {
        singleFileMaxWords: 120,
        multiFileMaxWords: 220,
      },
    },
  },
  output: {
    format: 'Use short sections and runnable TypeScript snippets when possible.',
  },
}

const releaseOverride = {
  reflexes: {
    constraints: ['Prefer migration-safe explanations over shorthand.'],
  },
}

const persona = withSessionContext(
  mergePersonas(basePersona, releaseOverride),
  'Current task: document the public SDK surface for docs.namzu.ai.',
)

const prompt = assembleSystemPrompt(persona)
console.log(prompt)
```

## 3. Skills Are Loaded from `SKILL.md`

The skill loader expects each skill to live in its own directory with a `SKILL.md` file and YAML frontmatter.

Key loader rules from the public implementation:

- the file must start with frontmatter
- `name` and `description` are required
- the `name` must match the directory name
- names must be lowercase kebab-case

To load a directory of skills:

```ts
import { SkillRegistry } from '@namzu/sdk'
import { join } from 'node:path'

const registry = new SkillRegistry()

const skills = await registry.registerAll(
  join(process.cwd(), '.namzu', 'skills'),
  'full',
)

console.log(skills.map((skill) => skill.metadata.name))
```

Why the disclosure level matters:

| Level | What you get |
| --- | --- |
| `metadata` | only name and description |
| `full` | metadata plus `SKILL.md` body |
| `assets` | currently also loads the body; use when your host additionally resolves skill assets |

If a skill body is missing, it cannot contribute instruction text to the assembled prompt.

## 4. Running a Persona Plus Skills Through an Agent

This example stays offline-friendly by using `MockLLMProvider`, but it exercises the real prompt surfaces:

```ts
import {
  MockLLMProvider,
  ReactiveAgent,
  ToolRegistry,
  withSessionContext,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const provider = new MockLLMProvider({
  model: 'mock-model',
  responseText: 'Persona and skill wiring is active.',
})

const agent = new ReactiveAgent({
  id: 'persona-agent',
  name: 'Persona Agent',
  version: '1.0.0',
  category: 'docs',
  description: 'Prompt-composition example.',
})

const persona = withSessionContext(
  {
    identity: {
      role: 'Documentation engineer',
      description: 'Write precise SDK explanations.',
    },
  },
  'Current workspace: docs.namzu.ai content source.',
)

const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Confirm that the persona is active.' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools: new ToolRegistry(),
    model: 'mock-model',
    tokenBudget: 4_096,
    timeoutMs: 30_000,
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
    persona,
    skills: [
      {
        metadata: {
          name: 'docs-writer',
          description: 'Write public-facing SDK documentation.',
        },
        dirPath: '/virtual/skills/docs-writer',
        body: '## Instructions\nPrefer precise public API names and runnable examples.',
      },
    ],
  },
)

console.log(result.result)
```

## 5. Skill Inheritance and Resolution

Use `resolveSkillChain()` when skills come from two levels, such as category defaults plus agent-local overrides:

```ts
import { resolveSkillChain } from '@namzu/sdk'

const chain = await resolveSkillChain(
  '/opt/namzu/skills/docs',
  '/opt/namzu/skills/release-agent',
  'full',
)

console.log(chain.inherited.map((skill) => skill.metadata.name))
console.log(chain.own.map((skill) => skill.metadata.name))
console.log(chain.resolved.map((skill) => skill.metadata.name))
```

Resolution rule:

- inherited skills are loaded first
- agent-local skills are loaded second
- later skills with the same name replace earlier ones in the resolved set

## 5b. Reading Frontmatter Yourself

`loadSkill` reads a `SKILL.md`. When you have markdown of your own with a `---`
block — a command file, a prompt template — use the same reader rather than
writing a second one:

```ts
import { parseFrontmatter } from '@namzu/sdk'

const { values, body } = parseFrontmatter(raw, `command at "${path}"`)
// values: {
//   description:     { kind: 'scalar',  value: 'Open a pull request' },
//   'argument-hint': { kind: 'scalar',  value: '<branch>' },
//   metadata:        { kind: 'mapping', entries: { author: 'someone' } },
// }
// body: everything after the closing fence, trimmed

const description = values.description
if (description?.kind !== 'scalar') {
  throw new Error('a command needs a scalar description')
}
```

Every key is one entry, and `kind` says whether it is a scalar or a one-level
block. That is a union rather than two parallel maps because **a key cannot be
both** — no YAML file can say it — and a shape that could represent it would
force every caller to invent a precedence for a case that never arrives. A file
that tries (a value *and* indented lines under one key) is refused rather than
half-read.

Three more things about it are deliberate:

- **It refuses rather than degrades.** Absent frontmatter, an unclosed fence, or
  YAML it does not implement — a block scalar (`>`/`|`), a flow sequence
  (`[a, b]`), a flow mapping (`{a: b}`) — all throw, naming your `source` label
  and the offending key. It never returns an empty result standing in for a file
  it could not read. This is why a second, "tolerant" reader is the wrong
  instinct: one that quietly returns no metadata gives you a file described
  wrongly instead of a file reported broken.
- **It does not know your vocabulary.** It validates no field names. A skill
  needs `name` and `description`; a command needs neither. Your validation stays
  yours — do not reach for `SkillMetadata` to describe something that is not a
  skill.
- **It parses every line ending**, including CRLF and lone CR. A file authored on
  Windows is the ordinary case, and a reader that only understands LF loses the
  whole frontmatter block without failing.

`loadSkill` is built on it, so a skill and a command file are read by the same
code and cannot drift apart.

## 6. One Very Important Runtime Detail

From the current prompt builder implementation:

- if `systemPrompt` is present, the runtime uses it directly
- if `systemPrompt` is absent and `persona` is present, the runtime calls `assembleSystemPrompt(persona, skills)`

That means `systemPrompt` wins over persona-driven prompt composition. Use one consciously; do not expect both to merge automatically.

## 7. Session Context Is Dynamic on Purpose

`withSessionContext()` does not just append more static prose. In the lower-level prompt builder, session context is split into the dynamic prompt segment so it can vary run to run without forcing the rest of the persona to change.

Use session context for:

- current repo or workspace information
- current task framing
- short-lived run metadata that should influence output

Do not use it for durable behavior rules. Durable rules belong in the base persona or skill body.

## 8. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| loading skills at `metadata` level and expecting them to affect the prompt | metadata-only skills do not carry instruction bodies |
| passing both `systemPrompt` and `persona` and expecting an automatic merge | the runtime prefers `systemPrompt` directly |
| putting per-run context into the base persona | it makes stable behavior harder to reuse |
| treating skills as opaque strings with no frontmatter rules | the loader validates `SKILL.md` shape and naming |
| hand-rolling a second frontmatter reader for your own markdown | two readers disagree — one throws where the other quietly returns nothing; use `parseFrontmatter` |
| using skills for hidden runtime state | keep private runtime data in `InvocationState`, not prompt text |

## Related

- [SDK Quickstart](../quickstart.md)
- [Agents and Orchestration](../agents/README.md)
- [Run Configuration](../runtime/configuration.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Extensions](../architecture/extensions.md)
- [Skill Loader Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/skills/loader.ts)
- [Persona Assembler Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/persona/assembler.ts)
