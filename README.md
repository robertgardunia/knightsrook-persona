# knightsrook-persona

Substrate layer that gives LLMs persistent memory, equilibrium, and continuity across context resets.

The LLM is unmodified. The substrate sits between user and model: it rates cohesion in-band on every turn, consolidates selectively at 25% of the context window, stores tiered memory across two purpose-built backends, and reinjects curated context on every fresh conversation restart. The entity survives context loss. The user doesn't manage memory — the substrate does.

## Stack

- **Runtime** — Node.js 20+, TypeScript
- **LLM** — Anthropic SDK (`claude-sonnet-4-6` by default; swap via `MODEL` env var)
- **Cohesion storage** — Postgres + pgvector (Docker) — vector similarity retrieval via `nomic-embed-text`
- **Factual storage** — MySQL — structured turn log + importance-tagged recall
- **Embeddings** — Ollama (`nomic-embed-text`, 768 dims, fully local)
- **Archive** — JSON file per turn (`data/archive/`), never deleted
- **Interface** — CLI REPL

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

**Sidebar panels:**
- **Session** — turn number, active persona
- **Cohesion** — score (1-10), bar, drivers, shifts
- **Context** — token usage vs budget, consolidation threshold marker
- **Retrieval** — cohesion path (count + cosine similarities), factual path (count + keyword hits)
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
8. If buffer > 25% of context limit → consolidation pass (LLM-driven, embeddings stored in Postgres)

### Storage split

| Backend | What lives there |
|---------|-----------------|
| **Postgres + pgvector** | Consolidated memories with embeddings — both cohesion and factual retrieval |
| **MySQL** | Every turn (raw log) |
| **data/archive/** | Full JSON per turn, never deleted |

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
| `CONTEXT_BUDGET_PCT` | `0.25` | Fraction of context window before consolidation triggers |
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
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `PERSONA_ID` | `default` | Active persona — all storage scoped to this ID |

## Tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

26 unit tests covering `cohesion`, `importance`, `normalizer`, and `embeddings`. Storage, consolidator, and substrate are integration-layer and require live DB + Anthropic — covered by the validation checklist below instead.

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
