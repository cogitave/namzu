---
'@namzu/sdk': minor
---

A retrieval namespace partitions what a query can see.

`TenantScope.namespace` and `KnowledgeBaseConfig.namespace` were declared from the start and neither reached storage. Ingestion copied `scope.tenantId` onto every chunk and dropped the namespace; the store filtered on tenant alone. So a partition a host asked for did not exist, and every namespace inside a tenant saw every other one's documents.

The namespace is now stamped onto each chunk at ingest and matched at search, across all three retrieval modes.

**An omitted namespace means the default partition, not the absence of a filter.** That distinction is the whole boundary: reading absence as "no filter" is how one leaks, because a caller who never asked for a namespace would then see every namespaced chunk in the tenant — the opposite of what partitioning is for. A caller who genuinely wants everything asks for each namespace it holds.

This is a behaviour change for existing data. Chunks ingested under a namespace before this release carry none, so they now answer only to a query with no namespace. Re-ingest to place them in a partition.

`RetrievalQuery.projectId` is **deprecated and documented as not consulted**. No chunk carries a project — ingestion stamps a tenant and a namespace, and `KnowledgeBaseConfig` has no project field to stamp a third from. Wiring one end of an isolation dimension is worse than wiring neither: a query filtering against a value nothing writes returns zero rows, and "no results" reads as "nothing matched" rather than "this scope was never stored".
