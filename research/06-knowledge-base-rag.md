# Knowledge Base / RAG Layer Architecture for an Enterprise Agent Platform

**Scope:** Design the knowledge base layer for an enterprise agent platform requiring BOTH a per-user personal KB and a shared-but-permission-scoped enterprise KB (企业知识库 / 个人知识库), with strict access control so retrieval never leaks data a user is not entitled to see.

**Date:** 2026-07-08. **Confidence:** Medium-high on architecture patterns (multiple converging sources); medium on specific benchmark numbers (many come from vendor/SEO blogs — flagged inline). Treat single-source latency/QPS figures as directional, not authoritative.

---

## 0. TL;DR Recommendations

1. **Vector DB: Qdrant** (Apache 2.0) as the primary store for an enterprise agent platform at scale, OR **pgvector** if you are already Postgres-heavy and under ~10M vectors and want one fewer system to operate. Both support the non-negotiable feature: metadata **pre-filtering** on ACL fields.
2. **Permission-aware retrieval:** Attach ACLs (allowed user IDs + group IDs, plus deny lists) as chunk metadata at ingestion, sync them from source systems, and enforce as a **pre-filter** injected server-side from the authenticated principal — never trust a client-supplied filter. Enforce before the candidate set is built, not after.
3. **Personal vs enterprise KB separation:** Yes, design the separation now — but as **metadata scopes/namespaces within a shared multi-tenant collection**, not separate infrastructure. Cheap to design in early, expensive to retrofit.
4. **GraphRAG:** Not now. Start with hybrid vector RAG + contextual retrieval + reranking. Add GraphRAG/LightRAG later only if you observe a real need for global/multi-hop "across the whole corpus" questions. It is expensive to index and operationally heavy.

---

## 1. Modern RAG Architecture Best Practices (2025–2026)

### 1.1 The big shift: linear → agentic
The naive `chunk → embed → retrieve → generate` pipeline is no longer the default. Enterprise RAG in 2026 decides *which* source/index/tool to consult **before** retrieving, can reformulate or decompose the query, and can self-correct ([Atolio](https://www.atolio.com/blog/enterprise-rag-guide), [Future AGI](https://futureagi.com/blog/rag-architecture-llm-2025)). Patterns named repeatedly: **query rewriting, multi-hop retrieval, Self-RAG, Agentic RAG**.

### 1.2 Hybrid search + reranking = table stakes
Pure vector search is no longer the recommended baseline. The current default is **BM25 (lexical) + dense vector + a reranker** ([Atolio](https://www.atolio.com/blog/enterprise-rag-guide), [Towards Data Science](https://towardsdatascience.com/hybrid-search-and-re-ranking-in-production-rag/)). Rationale: embedding models can wrongly treat distinct technical terms/IDs/SKUs as similar; lexical matching catches exact-term hits that dense retrieval misses. A reranker then refines the candidate set before it reaches the LLM context window.

### 1.3 Chunking
- Move beyond fixed-size splitting toward **semantic chunking** (boundaries follow meaning) ([Intuz](https://www.intuz.com/blog/advanced-rag-techniques)).
- Tune chunk size to the downstream job; agentic workflows need chunks that carry actionable context ([Fast.io](https://fast.io/resources/optimizing-rag-retrieval-agents/)).
- **Attach metadata at chunk-prep time** — this is what later powers ACL filtering and personal/enterprise scoping. This is the single most architecturally important chunking decision for this platform.

### 1.4 Anthropic Contextual Retrieval (primary source, hard numbers)
From [Anthropic's engineering post](https://www.anthropic.com/engineering/contextual-retrieval) (Sept 2024). Metric = failure rate = `1 − recall@20`:

| Technique | Failure rate | Reduction |
|---|---|---|
| Baseline (embeddings only) | 5.7% | — |
| + Contextual Embeddings | 3.7% | **35%** |
| + Contextual Embeddings + Contextual BM25 | 2.9% | **49%** |
| + Reranking (on top of both) | 1.9% | **67%** |

Mechanism: an LLM generates a short (50–100 token) chunk-specific context describing where the chunk sits in its parent document, prepended to the chunk before both embedding and BM25 indexing. Chunks are "no more than a few hundred tokens." Retrieving the top-20 chunks outperformed top-5/top-10.

Cost: with **prompt caching**, one-time contextualization is ~**$1.02 per million document tokens** (their assumptions: 800-token chunks, 8k-token docs, 50-token instruction, 100-token generated context). Prompt caching also cuts latency >2x and cost up to 90% for repeated prompts.

**Key threshold — when to skip RAG entirely:** if the whole knowledge base is **< ~200,000 tokens (~500 pages)**, just put it all in the prompt (with prompt caching). RAG earns its keep once the corpus exceeds the context window. This directly informs the personal KB: many *individual users'* personal KBs may be small enough to skip retrieval and load fully into context — a real simplification.

### 1.5 RAG vs Long-Context vs Fine-Tuning
Consensus (2026): not either/or; a **per-feature decision** ([tianpan.co](https://tianpan.co/blog/2026-04-27-long-context-vs-rag-2026-decision-tree), [metacto](https://www.metacto.com/blogs/rag-vs-fine-tuning-vs-other-llm-techniques-choosing-the-right-approach)):
- **RAG** = knowledge problem: facts that change, need citations, need compliance/audit and **per-user access control** (RAG is the only one of the three that can enforce document-level permissions at query time — decisive for this platform).
- **Fine-tuning** = behavior problem: style, tone, policy adherence, output format.
- **Long-context** = inject everything at inference; no retrieval infra, but "context rot" degrades recall in the middle of very long windows, and latency/cost climb ([tianpan](https://tianpan.co/blog/2026-04-27-long-context-vs-rag-2026-decision-tree)).
- 2026 default pattern: **RAG-first**, add fine-tuning only as a targeted optimization. A common costly mistake is fine-tuning when the real problem is retrieval.

---

## 2. Vector / Hybrid Database Comparison

All the self-hostable options below are permissively licensed (verified from source repos). The market has largely **converged on feature parity** (hybrid search, quantization, disk/mmap indexes); the real differentiators now are **deployment model, operational overhead, filtered-search quality, and cost** ([Calmops](https://calmops.com/ai/vector-databases-complete-guide/)).

### 2.1 Comparison table

| DB | License | Model | Hybrid (BM25+vec) | ACL / metadata pre-filter | Multi-tenancy story | Sweet spot | Ops burden | Notes |
|---|---|---|---|---|---|---|---|---|
| **pgvector** | PostgreSQL License (BSD-like, OSI) | Postgres extension | Via Postgres FTS + `tsvector`/hybrid (manual) | Yes — SQL `WHERE` is a true pre-filter; can leverage **Postgres RLS** | Rows + `tenant_id` column; RLS for hard isolation | Already on Postgres; **< ~10M vectors** | Lowest — no new service | ACID, joins to relational data. HNSW build slow at scale; fewer ANN knobs. |
| **Qdrant** | Apache 2.0 | Standalone (Rust) | Yes (native sparse+dense fusion) | Yes — strong payload filtering, **payload index** on tenant field | **First-class**: single collection + payload partition is the documented default; custom sharding at scale | General enterprise RAG, tens of millions+ vectors, low-latency filtered search | Medium (Docker/K8s) | Best-in-class filtered search + quantization. Recommended primary. |
| **Milvus** | Apache 2.0 | Standalone (distributed) | Yes | Yes (partition keys, scalar filters) | Partitions / partition-key; databases | **Billion-scale**, GPU indexing | High (many components: etcd, MinIO, Pulsar) | Overkill unless you truly need billion-scale. |
| **Weaviate** | BSD-3-Clause | Standalone (Go) | Yes (native, mature) | Yes | Native **multi-tenancy** (per-tenant shards) | Schema-rich apps, built-in hybrid, per-tenant isolation | Medium | Strong multi-tenant + hybrid; GraphQL API. ACORN speeds filtered search. |
| **Elasticsearch / OpenSearch** | Elastic v2/SSPL (ES) / Apache 2.0 (OpenSearch) | Standalone (JVM) | Yes — best-in-class lexical + vectors | Yes — mature doc-level & field-level security (ES) | Index-per-tenant or filtered aliases | Already run ELK; need full-text + logs + vectors in one | High (JVM heap tuning) | OpenSearch (Apache 2.0) avoids Elastic licensing. Vectors bolted onto a search engine. ES has built-in document-level security. |
| **LanceDB** | Apache 2.0 | Embedded / serverless (Lance columnar) | Yes (FTS + vector) | Yes | File/table-based; namespaces | Embedded, edge, low-ops, object-storage native | Very low (embedded) | Great for personal-KB/edge; less proven for large multi-tenant server clusters. |
| **Chroma** | Apache 2.0 | Embedded → server | Basic hybrid | Yes (metadata filter) | Collections | Prototyping, small/medium | Low | Developer-friendly; less proven at large enterprise scale/HA. |

Sources: [Qdrant LICENSE](https://github.com/qdrant/qdrant/blob/master/LICENSE), [Milvus LICENSE](https://github.com/milvus-io/milvus/blob/master/LICENSE), [Weaviate repo](https://github.com/weaviate/weaviate), [pgvector LICENSE](https://github.com/pgvector/pgvector/blob/master/LICENSE), [Big Data Boutique comparison](https://bigdataboutique.com/blog/vector-database-comparison-2026), [Medium tiering](https://medium.com/@elisheba.t.anderson/choosing-the-right-vector-database-opensearch-vs-pinecone-vs-qdrant-vs-weaviate-vs-milvus-vs-037343926d7e).

### 2.2 pgvector vs Qdrant — the practical decision boundary
- **pgvector** wins on operational simplicity, ACID, and joining vectors to relational data when you already run Postgres and are under ~10M vectors ([Internative](https://internative.net/insights/blog/best-vector-databases-2026-comparison), [Dupple](https://dupple.com/learn/best-vector-databases)). Watch-outs: CPU-bound HNSW build times get painful at scale; "in-memory HNSW ≠ production-ready" ([Timescale](https://blog.timescale.com/blog/pgvector-vs-qdrant)). `pgvectorscale` (Timescale, open source) mitigates some of this.
- **Qdrant** pulls ahead on throughput, low-latency **filtered** search, quantization, and horizontal scaling past tens of millions of vectors. Vendor/SEO benchmarks cite ~2.4x lower p99 and higher QPS than pgvector above ~5M vectors ([markaicode](https://markaicode.com/alternatives/pgvector-alternatives/)) — **directional only, validate on your own data**.

### 2.3 A key framing distinction
Dedicated ANN engines (Qdrant, Weaviate, Milvus) are purpose-built for vector retrieval and treat metadata as a filter layer on the index. General-purpose engines (Elasticsearch/OpenSearch) are mature search platforms with vectors added on — attractive if you also need heavy full-text/log search and want to consolidate infra ([Big Data Boutique](https://bigdataboutique.com/blog/vector-database-comparison-2026)). Benchmark caution: vendor numbers frequently contradict each other ([Firecrawl](https://www.firecrawl.dev/blog/best-vector-databases-2025)); a reproducible 14-case harness exists at [Hugging Face](https://huggingface.co/blog/ImranzamanML/pgvector-vs-elasticsearch-vs-qdrant-vs-pinecone-vs).

---

## 3. Permission-Aware / ACL-Filtered Retrieval (the critical requirement)

This is the part that must be right, because a bug here is a data-leak incident, not a quality regression.

### 3.1 The core pattern (converges across Glean, Amazon Q, Azure AI Search)
**Capture ACLs at crawl/ingest time; enforce at query time via the requesting user's identity, upstream of the LLM.** Content a user cannot access never enters the candidate set, never reaches the model, never appears in a citation.

- **Glean:** connectors mirror each source system's document-level permissions at index time; every search result, AI answer, and agent action respects them; unauthorized content never reaches the user or the LLM. Enforcement is *upstream of the model*. The same permission-awareness is carried through their MCP server ([Glean data protection](https://www.glean.com/perspectives/understanding-gleans-data-protection-vs-claude-enterprise), [Glean indexing permissions API](http://developers.glean.com/api-info/indexing/documents/permissions), [Glean MCP security](https://docs.glean.com/administration/platform/mcp/security)).
- **Amazon Q Business / Bedrock KB:** connectors crawl ACLs by default — indexing **user email, local group name, and federated group name** (e.g. SharePoint ↔ Entra ID) alongside each document; at query time responses are filtered to the user's access level ([Q connector concepts](https://docs.aws.amazon.com/amazonq/latest/qbusiness-ug/connector-concepts.html), [enable/disable ACL crawling](https://aws.amazon.com/blogs/machine-learning/enable-or-disable-acl-crawling-safely-in-amazon-q-business/), [Bedrock managed ACL](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html)). Bedrock stores allowed **and denied** users/groups.
- **Azure AI Search:** ingests ACL/permission metadata (Entra-based) so users without access to a file/folder don't see it in results — targeted at agentic grounding and RAG ([Azure doc-level access](https://learn.microsoft.com/EN-US/AZURE/search/search-indexer-access-control-lists-and-role-based-access), [Entra announcement](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/announcing-enterprise-grade-microsoft-entra-based-document-level-security-in-azu/4418584)).

### 3.2 How to attach ACLs to chunks
Store on **every chunk's metadata/payload**:
- `allowed_users: [userId, ...]` and `allowed_groups: [groupId, ...]`
- optional `denied_users` / `denied_groups` (deny overrides allow — Bedrock-style)
- `scope`: `personal:<userId>` or `enterprise` (drives the personal/enterprise split — see §5)
- `tenant_id` (multi-tenant isolation — see §6)
- `source_system`, `source_doc_id`, `acl_version`/`updated_at` (for staleness detection)

At query time, the server derives the principal's identity + resolved group memberships from the auth token and **injects the ACL filter itself**. The client must never be able to supply or override the filter.

### 3.3 Pre-filter vs post-filter — get this right (recall pitfall)
- **Post-filtering** (retrieve top-k by similarity, then drop unauthorized results) is dangerous. On a selective filter (e.g. a user who can see ~5% of the corpus), recall can silently collapse from ~95% to ~30% — no error, no warning — because HNSW returns its nearest neighbors first and then discards most of them, leaving too few authorized hits ([Mixpeek](https://mixpeek.com/guides/filtered-vector-search-pre-post-in-place), [Towards Data Science](https://towardsdatascience.com/effects-of-filtered-hnsw-searches-on-recall-and-latency-434becf8041c)). For ACLs this is doubly bad: it both hurts quality AND is unsafe if any post-filter step is missed.
- **Pre-filtering** (restrict to authorized/subset first, then do ANN over the survivors) preserves recall and is the correct choice for ACLs. Naive pre-filtering can break HNSW graph connectivity and cost latency; modern engines address this (**Weaviate ACORN**, Qdrant payload-index filtering, Elastic/Lucene filtered-HNSW, Milvus optimizations) ([Weaviate ACORN](https://weaviate.io/blog/speed-up-filtered-vector-search), [Elastic](https://www.elastic.co/search-labs/jp/blog/filtered-hnsw-knn-search)).
- **Requirement:** choose a DB that does true metadata **pre-filtering** with an index on the ACL/tenant fields. Qdrant, Weaviate, Milvus, Elasticsearch, and pgvector (SQL `WHERE` / RLS) all can; make sure the ACL fields are indexed.

### 3.4 Defense in depth
Even with pre-filtering, apply a **post-retrieval authorization re-check** on the final chunks before they enter the prompt (belt-and-suspenders), and enforce at the **vector layer** so unauthorized content never enters the candidate set at all ([tianpan.co](https://tianpan.co/blog/2026-05-04-permission-aware-retrieval-enterprise-rag-access-control), [Microsoft agent security filters](https://techcommunity.microsoft.com/blog/integrationsonazureblog/secure-ai-agent-knowledge-retrieval---introducing-security-filters-in-agent-loop/4467561)).

### 3.5 Pitfalls
- **Stale ACLs:** a user's access is revoked in the source system but the indexed ACL still grants it → leak. Mitigate with incremental ACL re-sync, short TTLs on cached group memberships, `acl_version`/`updated_at` checks, and (for high-sensitivity docs) a live authorization check against the source or a policy service (e.g. Amazon Verified Permissions / OPA) at query time.
- **Partial indexing:** if crawl fails mid-way or a doc is indexed before its ACL, it may be retrievable with wrong/no permissions. Fail **closed** (no ACL metadata ⇒ not retrievable) rather than open.
- **Group explosion / nested groups:** resolving transitive group membership is expensive; cache resolved memberships per user with a short TTL.
- **Rate limits during ACL sync** from source systems (SharePoint/CRM) need native handling ([Truto RBAC guide](https://truto.one/blog/how-to-maintain-document-level-rbac-in-enterprise-rag-pipelines/), [Microsoft ISE devblog](https://devblogs.microsoft.com/ise/sharepoint-doc-level-access)).
- **Deny-by-default:** model deny lists explicitly; when allow and deny conflict, deny wins.

---

## 4. Knowledge Graphs / GraphRAG

### 4.1 What it's for
Both **Microsoft GraphRAG** and **LightRAG** build a knowledge graph (entity + relationship extraction, community detection) from unstructured text instead of relying only on chunk similarity. The value: **global / corpus-wide / multi-hop questions** that no single chunk can answer — "what are the main themes across all our docs?", "how are these entities related?", temporal evolution. Standard vector RAG structurally fails these because it's a retrieval task, not a query-focused summarization task ([Microsoft Research / arXiv 2404.16130](https://arxiv.org/abs/2404.16130), [jacar.es](https://jacar.es/en/graphrag-microsoft-enterprise/)).

### 4.2 The cost
- **Microsoft GraphRAG:** four-stage LLM-heavy indexing (entity extraction → relationship extraction → community detection → graph-aware local/global/DRIFT search). Indexing is materially more expensive than chunk-and-embed — hundreds to thousands of dollars in tokens for a medium corpus ([jacar.es](https://jacar.es/en/graphrag-microsoft-enterprise/)). Microsoft continues to refine it (dynamic community selection, [DRIFT search](https://www.microsoft.com/en-us/research/blog/introducing-drift-search-combining-global-and-local-search-methods-to-improve-quality-and-efficiency/)).
- **LightRAG:** built specifically to cut GraphRAG's latency and token cost via dual-level retrieval + lightweight incremental indexing; reported far cheaper, and easier to update incrementally ([LightRAG overview](https://medium.com/data-science-in-your-pocket/what-is-lightrag-af1c7439f47c), [memoryhub](https://memoryhub.tistory.com/entry/RAG-Technology-Landscape-LightRAG-vs-Enterprise-Production-Systems)). Efficiency figures are vendor/blog-sourced — treat as directional.

### 4.3 Recommendation for this platform
**Don't build GraphRAG first.** Reasons: (1) most agent-platform queries are answerable from individual passages; (2) indexing cost + operational complexity are high; (3) **permission-aware access control is much harder on a graph** — entities/relationships aggregate info across many source docs with different ACLs, so a graph node can leak facts a user shouldn't see. This is a real, under-discussed risk for a permission-scoped KB. Start with hybrid vector RAG + contextual retrieval + reranking; revisit **LightRAG** (not full Microsoft GraphRAG) later if you observe genuine global/multi-hop demand, and confine it to a single ACL scope (e.g. within one tenant or one permission tier) to contain the leakage risk.

---

## 5. Personal vs Enterprise KB Separation

### 5.1 Design the separation now — as scopes, not separate systems
Introduce a `scope` dimension on every chunk from day one: `personal:<userId>` vs `enterprise` (+ finer enterprise sub-scopes as needed). It's cheap to design in early and expensive to retrofit. But implement it as **metadata scopes within the shared multi-tenant store**, not separate databases.

- **Personal KB** = documents a single user ingests (notes, their uploads, their connected personal accounts). ACL is trivially `allowed_users:[thatUser]`, `scope:personal:<userId>`. Because many personal KBs are small, remember the **§1.4 threshold**: if a user's personal corpus is < ~200k tokens, you can skip retrieval for it and load it directly into context with prompt caching — a legitimate simplification per user.
- **Enterprise KB** = shared corpus, permission-scoped by source-system ACLs (§3). Ingested/synced from enterprise systems (SharePoint, Confluence, Drive, CRM, wikis) with their ACLs mirrored.
- **Retrieval** typically queries both scopes for a user and merges/reranks: `scope == enterprise AND userAuthorized` OR `scope == personal:<currentUser>`. This is one filtered query, not two systems.

### 5.2 Ingestion / sync from enterprise systems
- **Connector-per-source** that pulls content **and** its ACLs together (the Glean/Amazon Q model). Never index content without its ACL.
- **Incremental indexing:** change-data-capture / delta crawls, not full re-crawls; update embeddings and ACLs on change. Track `source_doc_id` + `updated_at` + `acl_version`.
- **Keep ACLs in sync:** re-sync permissions on a schedule independent of content (permissions change more often than content), plus event-driven updates where the source supports webhooks. Handle source-system rate limits.
- **Deletion/tombstoning:** when a source doc is deleted or access revoked, remove/tombstone all its chunks promptly.

---

## 6. Multi-Tenant KB Isolation

**Default: single shared collection + payload/metadata partitioning** (`tenant_id`), with a payload index on the tenant field — not a collection/DB per tenant. This is Qdrant's explicitly documented recommendation and the practitioner consensus: one collection with payload filtering beats many small collections on memory, latency, and ops; per-user or per-tenant collections don't scale and waste infra ([Qdrant multitenancy guide](https://qdrant.tech/documentation/guides/multiple-partitions), [Qdrant massive-scale best practices](https://dev.to/qdrant/best-practices-for-massive-scale-deployments-multitenancy-and-custom-sharding-1mjb), [Substack: per-user DB doesn't scale](https://aiwthtarun.substack.com/p/should-each-user-get-their-own-vector)).

- **Isolation is enforced by the mandatory `tenant_id` pre-filter** (server-injected, same mechanism as ACLs).
- **Reach for separate collections only** for a small number of tenants needing hard physical isolation (e.g. contractual/regulatory data residency) ([goranstimac](https://goranstimac.com/blog/qdrant-multitenancy-and-collection-aliases-for-production-rag/)).
- **At massive scale:** custom sharding on a high-cardinality field (not ID alone) + mmap storage ([markaicode sharding](https://markaicode.com/architecture/qdrant-system-design-architecture-1089/)).
- AWS demonstrates a **single shared Knowledge Base** for multi-tenant RAG (cost/complexity win) with tenant isolation enforced by Verified Permissions ([AWS secure multi-tenant RAG](https://aws.amazon.com/blogs/architecture/secure-multi-tenant-rag-with-amazon-bedrock-and-verified-permissions/)).

**Composite filter at query time (server-built):**
`tenant_id == <caller tenant>` AND `(scope == 'enterprise' AND (allowed_users contains uid OR allowed_groups ∩ userGroups) AND NOT denied) OR (scope == 'personal:'+uid)`

<!--SECTION7-->



