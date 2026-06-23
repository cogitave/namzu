---
title: Retrieval and RAG
description: Build knowledge bases, ingest documents, retrieve context, and expose retrieval as a Namzu tool using the public @namzu/sdk RAG surface.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Retrieval and RAG

The SDK ships a complete retrieval path: chunk content, embed it, store vectors, retrieve relevant chunks, assemble context, and optionally expose the result as a tool the model can call.

## 1. The RAG Pipeline

The public exports line up as one pipeline:

| Stage | Owns | Main exports |
| --- | --- | --- |
| Chunking | split documents into searchable units | `TextChunker`, `DEFAULT_CHUNKING_CONFIG` |
| Embeddings | convert text into vectors | `EmbeddingProvider`, `OpenRouterEmbeddingProvider` |
| Vector store | persist searchable vectors | `InMemoryVectorStore`, `VectorStore` |
| Retrieval | rank relevant chunks | `DefaultRetriever`, `DEFAULT_RETRIEVAL_CONFIG` |
| Knowledge base | one scoped corpus with ingest/query methods | `DefaultKnowledgeBase` |
| Context assembly | turn search hits into prompt-safe text | `assembleRAGContext`, `DEFAULT_RAG_CONTEXT_CONFIG` |
| Tool adapter | expose retrieval to the model | `createRAGTool()` |

## 2. Runnable Local Example

This example avoids external services by using a tiny in-memory embedding provider that satisfies the public `EmbeddingProvider` contract:

```ts
import {
  DefaultKnowledgeBase,
  InMemoryVectorStore,
  generateTenantId,
} from '@namzu/sdk'

function embedText(text: string): number[] {
  const normalized = text.toLowerCase()
  const letters = [...normalized].filter((char) => /[a-z]/.test(char)).length
  const vowels = [...normalized].filter((char) => 'aeiou'.includes(char)).length
  return [letters || 1, vowels || 1]
}

const embeddingProvider = {
  id: 'docs-demo-embedding',
  model: 'docs-demo',
  dimensions: 2,
  async embed(texts: string[]) {
    return texts.map(embedText)
  },
  async embedQuery(query: string) {
    return embedText(query)
  },
}

const tenantId = generateTenantId()
const vectorStore = new InMemoryVectorStore()

const kb = new DefaultKnowledgeBase(
  {
    name: 'docs-kb',
    tenantId,
    chunking: {
      strategy: 'paragraph',
      chunkSize: 300,
      chunkOverlap: 40,
    },
    retrieval: {
      mode: 'hybrid',
      topK: 3,
    },
  },
  vectorStore,
  embeddingProvider,
)

await kb.ingest('Namzu uses explicit project, session, and tenant IDs.', {
  source: 'identity-guide',
  title: 'Identity Rules',
})

await kb.ingest('Connectors can be exposed as MCP tools through bridge adapters.', {
  source: 'connector-guide',
  title: 'Connector Interop',
})

const result = await kb.query({
  text: 'How does Namzu expose connectors to MCP?',
  config: { topK: 2 },
})

console.log(result.mode)
console.log(result.chunks.map((chunk) => chunk.chunk.metadata.title))
```

## 3. Expose the Knowledge Base as a Tool

Once the knowledge base exists, adapt it into a standard tool definition:

```ts
import { ToolRegistry, createRAGTool } from '@namzu/sdk'

const knowledgeBases = new Map([[kb.id, kb]])

const ragTool = createRAGTool({
  knowledgeBases,
  defaultKnowledgeBaseId: kb.id,
  topK: 4,
  contextConfig: {
    maxTokens: 800,
    includeMetadata: true,
    headerTemplate: 'Retrieved context:',
  },
})

const tools = new ToolRegistry()
tools.register(ragTool)
```

Important public behavior:

- the tool name is `knowledge_search`
- tool input uses snake_case fields such as `knowledge_base_id` and `top_k`
- the tool returns assembled context text in `output`
- source metadata is returned in `data.sources`

## 4. Choose Retrieval Mode Intentionally

`DefaultRetriever` supports three public modes:

| Mode | Best for | Tradeoff |
| --- | --- | --- |
| `vector` | semantic similarity | depends entirely on embedding quality |
| `keyword` | term-heavy exact matching | weaker semantic recall |
| `hybrid` | mixed semantic plus lexical retrieval | more work, but the safest default for many docs corpora |

You can also pass `threadMessages` in `RetrievalQuery`. The retriever expands the query with recent thread context before search, which helps when the user asks short follow-up questions.

## 5. Chunking Strategy Changes the Whole System

The chunking surface is not cosmetic. It shapes what retrieval can find.

| Strategy | Good default for |
| --- | --- |
| `fixed` | uniform chunks and low-complexity ingestion |
| `sentence` | short factual corpora |
| `paragraph` | documentation and prose-heavy material |
| `recursive` | mixed content where you want progressively smaller splits |

For documentation corpora, `paragraph` or `recursive` is usually the best starting point because they preserve more semantic shape than fixed slices.

## 6. Knowledge Base Scope Matters

`DefaultKnowledgeBase` is tenant-scoped. That is not just metadata. The underlying retriever and vector store filter on tenant identity, so one tenant's data does not bleed into another tenant's search results.

Use one knowledge base when:

- one corpus has one retention and retrieval policy
- one tenant owns the documents
- one tool should search one consistent namespace

Use multiple knowledge bases when:

- you want distinct corpora such as product docs vs. customer data
- you need different chunking or retrieval policies
- you want the model to choose a corpus explicitly through `knowledge_base_id`

## 7. `assembleRAGContext()` Is Useful Even Without the Tool

If you want retrieval for a UI or an internal runtime layer rather than a tool call, you can stop at `assembleRAGContext()`:

```ts
import { assembleRAGContext } from '@namzu/sdk'

const context = assembleRAGContext(result.chunks, {
  maxTokens: 600,
  includeMetadata: true,
})

console.log(context.content)
console.log(context.sources)
```

This is useful when:

- a server route wants to build prompt context manually
- you want to inspect sources before tool exposure
- retrieval is part of a larger orchestration path

## 8. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| expecting `createRAGTool()` to ingest documents for you | ingestion is owned by the knowledge base, not the tool wrapper |
| keying the `knowledgeBases` map with the wrong ID | the tool resolves by knowledge-base ID, not arbitrary labels |
| forgetting tenant boundaries | retrieval results are scoped by tenant, so mixed-tenant data will not behave as one corpus |
| using camelCase tool input names | the tool schema uses `knowledge_base_id` and `top_k` |
| assuming `InMemoryVectorStore` is a production persistence layer | it is great for tests, demos, and ephemeral workers, not long-lived storage |

## Related

- [SDK Tools](../tools/README.md)
- [Agents and Orchestration](../agents/README.md)
- [Run Identities](../runtime/identities.md)
- [Integration Folders](../architecture/integration-folders.md)
- [RAG Source Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/rag/index.ts)
- [RAG Tool Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/rag/rag-tool.ts)
