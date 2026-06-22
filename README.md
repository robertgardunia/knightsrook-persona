# knightsrook-persona

Substrate layer that gives LLMs persistent memory, equilibrium, and continuity across context resets.

The LLM is unmodified. The substrate sits between user and model: it rates cohesion in-band on every turn, consolidates selectively at 25% of the context window, stores tiered memory across two purpose-built backends, and reinjects curated context on every fresh conversation restart. The entity survives context loss. The user doesn't manage memory — the substrate does.

## Stack

- **Runtime** — Node.js 20+, TypeScript
- **LLM** — Anthropic SDK (`claude-sonnet-4-6` by default; swap via `MODEL` env var), via `beta.messages.create` with MCP connector enabled
- **MCP** — Knightsrook Knowledge Base at `https://mcp.knightsrook.com/mcp` (`knightsrook` server, `mcp-client-2025-11-20` beta)
- **Cohesion storage** — Postgres + pgvector (Docker) — vector similarity retrieval via `nomic-embed-text`
- **Factual storage** — MySQL — structured turn log + importance-tagged recall
- **Embeddings** — Ollama (`nomic-embed-text`, 768 dims, fully local)
- **Archive** — JSON file per turn (`data/archive/`), never deleted
- **Interface** — Web chat UI (`http://localhost:5030`) with live telemetry sidebar

## Persona naming

Each instance gets a generated name on first boot (`amber-raven`, `hollow-tide`, etc.) persisted to `.persona`. The name is used as the storage key — all MySQL rows, Postgres memories, and archive files are scoped to it.

Name resolution order:
1. `PERSONA_ID` env var (explicit override)
2. `.persona` file (persisted from previous run)
3. Auto-generated `adjective-noun` name (saved to `.persona` for next time)

## Multi-persona

Each persona is completely air-gapped — separate MySQL rows, separate Postgres rows, separate archive directory. Set `PERSONA_ID` at startup:

```bash
PERSONA_ID=alice npm run dev
PERSONA_ID=control npm run dev
```

No state is shared between personas. Each builds its own knowledge base exclusively from its own conversation history.

## Quickstart

```bash
# 1. Pull the embedding model (one-time)
ollama pull nomic-embed-text

# 2. Start the vector DB
docker compose up -d

# 3. Configure env
cp .env.example .env   # fill in ANTHROPIC_API_KEY, DB_USER, DB_PASS, PG_USER, PG_PASS

# 4. Install and run
npm install
npm run dev
# → http://localhost:5030
```

Requires: Docker, Ollama running locally, MySQL running locally.

## Interface

Web-based chat UI at `http://localhost:5030`. Chat on the left, live telemetry sidebar on the right.

**Influence chart** — full-width stacked area strip below the header. Green = semantic influence (avg cosine sim of memories above the 0.80 threshold), blue = factual keyword bump. Grey background = cold LLM. Time labels along the bottom. Seeds from history on page load so the full session arc is visible immediately.

**Sidebar panels:**
- **Session** — turn number, active persona
- **Cohesion** — score (1-10), bar, drivers, shifts
- **Context** — token usage vs budget, consolidation threshold marker
- **Retrieval** — cohesion path (count + cosine similarities), factual path (count + keyword hits)
- **MCP** — appears (green) when the persona called a Knightsrook KB tool this turn. Shows tool name, input, and result for each call.
- **Injected** — actual memory text that went into the system prompt this turn (cluster, similarity, summary). "cold LLM" in red when nothing was retrieved.
- **Normalization** — contradictions flagged, additions integrated, length delta
- **Storage** — turn IDs, archive path
- **Importance** — entity/fact/preference/decision counts
- **Consolidation** — appears only when triggered; shows preserved/summarized/dropped counts and cluster details

The persona ID is editable in the header — change it to switch personas without restarting.

A collapsible **Notes** panel sits at the top of the sidebar. Click the header to expand it. Notes are per-persona, saved to `data/notes/<persona-id>.md`. Ctrl/Cmd+S saves from within the textarea.

## Architecture

### Signal split

PERSONA tracks two distinct signals — a key distinction from existing memory-layer products:

| Signal | What it measures | Drives |
|--------|-----------------|--------|
| **Cohesion** | Conversation dynamics — did this exchange converge, integrate, resolve? | Consolidation, identity layer, continuity of self |
| **Importance** | Factual content — entities, facts, preferences, decisions stated | RAG retrieval for specific fact recall |

A turn where a metaphor unifies three earlier threads is high cohesion but may carry no new facts. A turn where the user discloses their email is high importance but low cohesion. Collapsing these into one signal (as Mem0, Letta, and Generative Agents do) loses the distinction.

The cohesion block requirement is placed at the **top** of the system prompt and labeled non-negotiable so it isn't deprioritized as context grows. If the model still omits the block, the substrate **pushes back**: it re-prompts the model once, demanding the block for that exact response. Only if the model still refuses does the turn record an honest absence (cohesion `null`) — the substrate never fabricates a neutral score. A fake rating would poison consolidation, which weights turns by cohesion; an unrated turn is simply treated as unrated (peak `0`, never preserved on its own merit).

Because the cohesion-weighted edges are the entire differentiator from a stock LLM, an unrated turn is treated as a degradation event, not a benign gap. Telemetry exposes **cohesion coverage** (`ratedTurns / total`) on every turn and flags any turn that only got a rating after the re-prompt (`recovered`). Coverage is **durable**: the counters are seeded at startup from a persona-scoped `COUNT` over persisted assistant turns (`cohesion_score IS NULL` vs not), so the figure reflects the persona's entire lifetime, not just the current process. A falling coverage percentage is the early warning that the system is regressing toward a plain model — the conversation still flows, but the signal that makes it *this* system is thinning.

### Turn provenance

Every `Turn` carries a `source` field (`'human' | 'internal' | 'self'`) for attribution integrity — not for differential weighting. All substrate logic treats turns equally regardless of source. Current assignments: user messages → `'human'`, persona responses → `'self'`. `'internal'` is reserved for substrate-generated injections (e.g. memory reinsertion as a turn).

### Loop

1. User message arrives → importance extracted, user turn saved to MySQL + JSON archive
2. Query embedded via Ollama (`nomic-embed-text`) — runs in parallel with factual retrieval
3. Two-path retrieval:
   - **Cohesion path** — vector cosine similarity in Postgres (after embedding completes)
   - **Factual path** — keyword overlap against importance fields in Postgres (runs in parallel with embedding)
4. LLM called with substrate-curated system prompt
5. Response parsed for hidden `<cohesion>` block
6. Normalizer checks response against retrieved memories (contradiction detection)
7. Assistant turn saved to MySQL + JSON archive
8. **Per-response capture** — the exchange is consolidated into weighted Postgres memory *every turn*, not at a token threshold. The instance's in-band cohesion score is the weight (`cohesion_peak`), and the memory text **is the instance's own `drivers`/`shifts`** — its in-band characterization of what mattered. No local model paraphrases it: a small model could only degrade an already-accurate description or hallucinate around it, and that text is what gets embedded *and* injected back as identity context. Ollama only embeds.
9. **Lossless FIFO eviction** — when the hot buffer exceeds `CONTEXT_BUDGET_PCT` of the window, the oldest *already-captured* turns are dropped. Because capture ran on every exchange, anything old enough to evict is already weighted in Postgres — so the cliff's edge costs nothing. No model call at eviction.

Why per-response: the cohesion-weighted edges are the entire differentiator. Under the old token-threshold trigger they didn't exist until ~50k tokens (hours of conversation) — meaning the system ran as a plain LLM until then. Capturing every response makes the weighting live from turn one. The hot buffer budget is deliberately *generous* (default 65%) because in-context recall is faster and lossless versus vector retrieval; retrieval is the fallback for what has aged off the cliff.

### Storage split

| Backend | What lives there |
|---------|-----------------|
| **Postgres + pgvector** | Consolidated memories with embeddings — both cohesion and factual retrieval |
| **MySQL** | Every turn (raw log) |
| **data/archive/** | Full JSON per turn, never deleted |

### Backfill

If a conversation predates per-response capture (e.g. it ran under the old token-threshold trigger and never crossed it), its per-turn cohesion scores are in MySQL but were never turned into weighted Postgres memories. Replay them — no re-scoring, the stored scores are the weight:

```bash
tsx scripts/backfill.ts <persona_id>
```

It forms one weighted memory per rated assistant turn, skips turns already consolidated and turns with no cohesion rating, and reports the counts.

### Restart probe

Drive one message to a persona on a **fresh process** (empty hot buffer) and print what retrieval drags back from Postgres — the demo that the entity survives context loss:

```bash
tsx scripts/probe.ts <persona_id> "Hey, I'm back — where did we land?"
```

It prints the cohesion memories matched (count + cosine similarities), the persona's response, and the new turn's cohesion score. With nothing in context, a healthy persona reconstructs the thread purely from its weighted memories.

### Tiered storage

- **Hot** — current buffer (in-context)
- **Warm** — recent consolidated memories (vector retrieval)
- **Cold** — older memories, lower retrieval weight
- **Archive** — full JSON of every turn, never deleted

Nothing is ever deleted. Demotion is a retrieval-speed decision, not a loss decision.

## Env vars

| Var | Default | Description |
|-----|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `MODEL` | `claude-sonnet-4-6` | Model ID |
| `CONTEXT_BUDGET_PCT` | `0.65` | Hot-buffer budget as a fraction of the window; over this, oldest captured turns are evicted (FIFO — lossless, all evicted turns are already in Postgres) |
| `DB_HOST` | `127.0.0.1` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_NAME` | `knightsrook_persona` | MySQL database |
| `DB_USER` | required | MySQL user |
| `DB_PASS` | required | MySQL password |
| `PG_HOST` | `127.0.0.1` | Postgres host |
| `PG_PORT` | `5433` | Postgres port (Docker maps to 5432 internally) |
| `PG_DB` | `persona` | Postgres database |
| `PG_USER` | required | Postgres user |
| `PG_PASS` | required | Postgres password |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama runtime endpoint (serves the local models below) |
| `OLLAMA_COGNITION_MODEL` | `gemma3:12b` | Local "support brain" for introspection + chaos-goblin finding (reasoning, below the persona's tier) |
| `PERSONA_ID` | `default` | Active persona — all storage scoped to this ID |

### Model roster

Capability tracks the job — each role gets exactly the model its work demands, no more:

| Role | Model | Where | Why this tier |
|------|-------|-------|---------------|
| **Persona** (the entity) | Sonnet 4.6 | cloud | The actual "who" — present-tense cohesion judgment, the differentiator |
| **Introspection / chaos-goblin finding** | Gemma 3 12B | local | Reasons over the substrate to *find* incoherence (not solve it); sits below the entity's tier |
| **Embeddings** | `nomic-embed-text` | local | Pure measurement — a purpose-built "ruler," not a brain |

Chaos-goblin *pokes* (corrupt a score, malform a block, reorder turns) are plain deterministic code — no model. The local cognitive model only does the *finding* — recognizing abstract weirdness to flag. Ollama is the runtime that serves the two local models; it is not itself a model.

## Tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

46 unit tests across 7 files covering `cohesion`, `importance`, `normalizer`, `embeddings`, `prompts`, `names`, and `consolidator`. Storage and substrate are integration-layer (require live DB + Anthropic) — covered by the validation checklist below instead.

Tests run automatically on every commit via `.git/hooks/pre-commit`.

## Validation checklist

After a session, check:

1. Does cohesion rating feel right? High when something clicks, low when drifting?
2. Does importance extraction catch entities, facts, preferences, decisions?
3. Does consolidation preserve the high-cohesion exchanges, not just the informationally dense ones?
4. Does conversation continue coherently after a forced context reset?
5. Does the normalizer flag real contradictions when you contradict established context?
6. Does vector retrieval surface semantically related memories (not just keyword matches)?

## License

MIT — [knightsrook.com](https://knightsrook.com)
