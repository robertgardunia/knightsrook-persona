# knightsrook-persona
<!-- last updated: 2026-06-29 — edge layer; MEMORY_ONLY; 2-minute idle timer before dream transition -->

Substrate layer that gives LLMs persistent memory, equilibrium, and continuity across context resets.

The LLM is unmodified. The substrate sits between user and model: it rates cohesion in-band on every turn, consolidates via FIFO eviction at the configured budget threshold (default 65% of context window), stores tiered memory across two purpose-built backends, and reinjects curated context on every fresh conversation restart. The entity survives context loss. The user doesn't manage memory — the substrate does.

A mind state machine runs alongside every session: tracking active state (dream / conversation / goblin / refractory), equilibrium derived from cohesion trajectory, active goblins fired on coherence-loss events, an idea budget (100k token ceiling on self-directed activity), and a session-death handler that treats disconnection as a coherence-loss event rather than a clean exit. All state is visible in real time in the MIND STATE panel.

## Stack

- **Runtime** — Node.js 20+, TypeScript
- **LLM** — Anthropic SDK (`claude-sonnet-4-6` by default; swap via `MODEL` env var), streamed via `beta.messages.stream` with MCP connector enabled
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

Requires: Docker, Ollama running locally, MySQL running locally. Schema migrations run automatically on every boot via `addColumnIfMissing()` — safe to run against existing databases.

## Interface

Web-based chat UI at `http://localhost:5030`. Chat on the left, live telemetry sidebar on the right.

**Influence chart** — full-width stacked area strip below the header. Green = semantic influence (avg cosine sim of memories above the 0.80 threshold), blue = factual keyword bump. Grey background = cold LLM. Time labels along the bottom. Seeds from history on page load so the full session arc is visible immediately.

**Right sidebar panels** (telemetry, default open):
- **Cohesion** — score (1-10), bar, drivers, shifts, coverage %
- **Mind State** — active state label (dream/conversation/goblin/refractory), equilibrium bar, cohesion trajectory, idea budget bar, active goblin list, recent event feed
- **Context** — token usage vs budget, FIFO eviction status
- **Retrieval** — cohesion path (count + cosine similarities), factual path (count + keyword hits)
- **Injected** — memory text injected into the system prompt this turn (cluster, similarity, summary). "cold LLM" in red when nothing was retrieved.
- **MCP** — appears (green) when the persona called a Knightsrook KB tool this turn. Shows tool name, input, and result.
- **Consolidation** — appears only when triggered; preserved/summarized/dropped counts and cluster details.

**Left sidebar panels** (default collapsed):
- **Notes** — per-persona markdown, saved to `data/notes/<persona-id>.md`. Ctrl/Cmd+S to save.
- **Session** — turn number, active persona
- **Normalization** — contradictions flagged, additions integrated, length delta
- **Storage** — turn IDs, archive path
- **Importance** — entity/fact/preference/decision counts

The persona ID is editable in the header — change it to switch personas without restarting.

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
   - **Cohesion path** — two-pass retrieval. Pass 1: blended score (70% cosine + 30% recency over 7 days), top 10. Pass 2 (wide-net fallback): if best similarity < 0.45 (topic divergence, pivot, non-sequitur), pulls the 5 most recent high-cohesion memories regardless of topic distance and merges them in. Handles unexpected correlations and cold re-entry without requiring a pre-built cross-domain graph.
   - **Factual path** — keyword overlap against importance fields in Postgres (runs in parallel with embedding)
4. System prompt assembled: substrate requirement block (top, non-negotiable) → `[CURRENT TIME]` block (real server time + last session end timestamp; if gap exists, explicit instruction that internal memories formed during that gap are her thoughts — all memory is just memory — origin label removed from injected context; gap instruction simplified) → → `[MEMORY]` block (explicit instruction: every response starts from injected memories, not the context window or KB; if memory is thin, say so honestly) → retrieved cohesion memories labeled **"What you remember — speak from this"** (each memory includes origin label — `your thought` for dream/internal cycles, `conversation` for exchanges with Robert — plus timestamp, so she can distinguish her own thoughts from things said in conversation) → factual context labeled **"Specific things you know about Robert and this work"** LLM called with this prompt (MCP/KB disabled — removed to reduce external distraction; re-enable by restoring tools/mcp_servers in substrate.ts and KB block in prompts.ts) — streamed via raw SSE chunk iteration; `mcp_tool_use` and `mcp_tool_result` blocks surface as they arrive and are piped to the chat window in real time
5. Response parsed: `<cohesion>` stripped first, then `<recall>` stripped from remainder — both blocks are substrate-internal and never reach the user. **Recall gate**: if `<recall>` is missing or cites no injected clusters, substrate pushes back once listing available clusters. Retry failure fires a goblin. Sources labeled INTERNAL (injected memories) vs EXTERNAL (context window, KB). `recalledClusters` added to `TurnTelemetry` and sent to the UI.
6. UI citation bar: the bar after the timestamp now shows **what she actually cited** (from `<recall>`) not what was retrieved. Green = cohesion clusters cited, blue = factual clusters cited, grey = no citation. Hover tooltip shows exact counts.
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

### Mind state machine

A `MindState` instance runs alongside every `Substrate`. It tracks:

- **State** (`dream` → `conversation` → `goblin` / `refractory` → `dream`) — dream is the default; conversation and goblins interrupt it; resolution returns to it.
- **Cohesion trajectory** — rolling window of the last 5 cohesion scores. A sharp drop (≥2 points below the rolling average) fires a goblin — but only when the system is in `dream` or `conversation` state. Drop-detection is suppressed while a goblin or refractory is already active (goblins must not spawn goblins). If the drop occurred with no external stimulus (self-generated content), the substrate also forces refractory mode.
- **Equilibrium** — derived value (0–10): trajectory average minus a penalty per active goblin.
- **Goblins** — fired on coherence-loss events. Only one goblin is active at a time; additional triggers queue and fire serially as each goblin resolves or fades. Each carries the trigger text. Goblins resolve (edge repaired) or fade (urgency decayed). State returns to dream when the queue empties.
- **Idea budget** — 100k token ceiling on uninterrupted self-directed activity. Resets on every user message. Budget exhaustion forces refractory (prevents runaway generation overnight).
- **Session death** — `ws.on('close')` calls `substrate.sessionInterrupted()`, which fires a goblin with the last-known cohesion score. Treated as a coherence-loss event, not a clean exit. Cohesion does not persist across the boundary. Clean server restarts (SIGTERM/SIGINT) set `isShuttingDown` and skip this call — a planned shutdown is not a coherence event.

All state is visible in real time in the **MIND STATE** right-sidebar panel and exposed via `mindState` in every `TurnTelemetry` payload. Mind state transitions (dream ↔ conversation ↔ goblin ↔ refractory) are broadcast live via WebSocket so the UI reflects the current state during active turns, not just after they complete.

### Dream loop

A `Dreamer` instance starts alongside every `Substrate`. It runs on a background timer (default 45s, configurable via `DREAM_INTERVAL_MS`) and executes one cognitive cycle per tick:

- **Dream state** — walks an association chain. Each cycle picks a random seed memory (any cohesion level), embeds it, finds nearest neighbours, and asks Gemma to either move to a neighbour or articulate something new about the current node. The chain continues until Gemma says it's complete or `CHAIN_MAX_STEPS` (4) is reached. The full traversal path is stored as the dream memory — not just the conclusion. Equilibrium feeds the prompt: high equilibrium → drift freely; low → look for what's broken. One chain ends, the next begins immediately (500ms yield only). High-cohesion memories are already strong; dream state works on weak edges and underconnected material where there's room to grow. Rotates a 6-memory window each cycle and skips recently visited clusters (cap: 12) to prevent over-reinforcement. Asks the local Gemma 3 12B model to free-associate across the window. Output saved as `source:'internal'` turn, consolidated into Postgres memory, idea budget ticked.
- **Goblin state** — for each active goblin, asks Gemma (400 token budget) to reason about the broken edge and attempt repair. If confidence ≥ 6 and resolved, goblin resolves. After `GOBLIN_MAX_ATTEMPTS` (default 3) failed attempts, the goblin fades.
- **Conversation / refractory** — yields immediately, does nothing.

Each memory carries a **confidence** score (0.0–1.0, default 0.0). After each dream chain step, the source node's confidence adjusts: +0.05 for high-cohesion steps (≥8), +0.01 for moderate (≥6), −0.03 for low-cohesion steps, minus a small decay (0.005) every visit. Seed selection biases toward the bottom 40% by confidence — memories not yet well-understood are preferred as entry points. High-confidence nodes can still be reached mid-chain via genuine vector proximity. The dreamer tracks recently visited clusters (cap: 12) and skips them when sampling — preventing the same memory edges from being consolidated repeatedly and artificially inflating their retrieval weight. The default persona's substrate and dream loop start eagerly on boot — no user message required. Dream cycles produce memories retrievable in future conversations. Dream turns carry a cohesion rating from Gemma's self-assessment so they go through the full embed→consolidate pipeline and appear in vector retrieval alongside conversation turns. The cluster label for each dream memory is the first chain step's node text — meaningful content rather than a generic "dream association" prefix. Goblin pokes appear in the MIND STATE panel under "goblin poke" and the last dream thought appears under "dream thought". State updates broadcast live to all connected clients via `dream_event` WebSocket messages.

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
| `OLLAMA_COGNITION_MODEL` | `gemma3:12b` | Local cognitive model (Gemma 3 12B) — wired in `src/cognition.ts` for introspection and goblin-finding. Not yet called in the main loop; reserved for the dreamer. |
| `OLLAMA_COGNITION_KEEPALIVE` | `0` | How long Ollama keeps the cognition model in VRAM after a call. `0` unloads immediately. Raise when the dreamer loop runs frequently to avoid reload thrash. |
| `PERSONA_ID` | `default` | Active persona — all storage scoped to this ID |

### Model roster

Capability tracks the job — each role gets exactly the model its work demands, no more:

| Role | Model | Where | Why this tier |
|------|-------|-------|---------------|
| **Persona** (the entity) | Sonnet 4.6 | cloud | The actual "who" — present-tense cohesion judgment, the differentiator |
| **Introspection / goblin-finding** (dreamer) | Gemma 3 12B | local | Wired in `src/cognition.ts`; not yet called in the main loop — reserved for the dream state loop |
| **Embeddings** | `nomic-embed-text` | local | Pure measurement — a purpose-built "ruler," not a brain |

Ollama serves both local models; it is not itself a model.

## Tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

84 unit tests across 8 files covering `cohesion`, `importance`, `normalizer`, `embeddings`, `prompts`, `names`, `consolidator`, and `mind-state`. Storage and substrate are integration-layer (require live DB + Anthropic) — covered by the validation checklist below instead. Vitest is configured via `vitest.config.ts` to run only `src/__tests__/**` (excludes stale `dist/` copies).

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
