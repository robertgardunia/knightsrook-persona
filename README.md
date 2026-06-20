# knightsrook-persona

Substrate layer that gives LLMs persistent memory, equilibrium, and continuity across context resets.

The LLM is unmodified. The substrate sits between user and model: it rates cohesion in-band on every turn, consolidates selectively at 25% of the context window, stores tiered memory in SQLite, and reinjects curated context on every fresh conversation restart. The entity survives context loss. The user doesn't manage memory — the substrate does.

## Stack

- **Runtime** — Node.js 20+, TypeScript
- **LLM** — Anthropic SDK (bring your own key; swap model via `MODEL` env var)
- **Storage** — SQLite via `better-sqlite3` + JSON archive (full-fidelity, never deleted)
- **Interface** — CLI REPL

## Quickstart

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm install
npm run dev
```

## Architecture

### Signal split

PERSONA tracks two distinct signals — a key distinction from existing memory-layer products:

| Signal | What it measures | Drives |
|--------|-----------------|--------|
| **Cohesion** | Conversation dynamics — did this exchange converge, integrate, resolve? | Consolidation, identity layer, continuity of self |
| **Importance** | Factual content — entities, facts, preferences, decisions stated | RAG retrieval for specific fact recall |

A turn where a metaphor unifies three earlier threads is high cohesion but may carry no new facts. A turn where the user discloses their email is high importance but low cohesion. Collapsing these into one signal (as Mem0, Letta, and Generative Agents do) loses the distinction.

### Loop

1. User message arrives → importance extracted
2. Two-path retrieval: cohesion-weighted (continuity context) + importance-tagged (fact recall)
3. LLM called with substrate-curated system prompt
4. Response parsed for hidden `<cohesion>` block
5. Normalizer checks response against retrieved memories (contradiction detection + missed-relevance injection)
6. Assistant turn saved with cohesion rating + importance tags
7. If buffer > 25% of context limit → consolidation pass

### Tiered storage

- **Hot** — current buffer (in-context)
- **Warm** — recent consolidated memories (sub-second keyword retrieval)
- **Cold** — older memories, lower retrieval weight
- **Archive** — full JSON of every turn, never deleted

Nothing is ever deleted. Demotion is a retrieval-speed decision, not a loss decision.

## Env vars

| Var | Default | Description |
|-----|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `MODEL` | `claude-sonnet-4-6` | Model ID |
| `CONTEXT_BUDGET_PCT` | `0.25` | Fraction of context window before consolidation triggers |

## Validation checklist

After a session, check:

1. Does cohesion rating feel right? High when something clicks, low when drifting?
2. Does importance extraction catch entities, facts, preferences, decisions?
3. Does consolidation preserve the high-cohesion exchanges, not just the informationally dense ones?
4. Does conversation continue coherently after a forced context reset?
5. Does the normalizer flag real contradictions when you contradict established context?
6. Does the normalizer inject relevant prior facts when you ask something the substrate knows?

## License

MIT — [knightsrook.com](https://knightsrook.com)
