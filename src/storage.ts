import mysql from 'mysql2/promise'
import pg from 'pg'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Turn, ConsolidatedMemory } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')

export type RetrievedMemory = ConsolidatedMemory & { similarity?: number; keywordHits?: number }

// @pattern:db-singleton
export class Storage {
  private mysql!: mysql.Pool
  private pg!: pg.Pool
  private personaId: string
  private archiveDir: string
  private ready: Promise<void>

  constructor(personaId: string) {
    this.personaId = personaId
    this.archiveDir = join(DATA_DIR, 'archive', personaId)
    mkdirSync(this.archiveDir, { recursive: true })
    this.ready = this.init()
  }

  private async init() {
    this.mysql = mysql.createPool({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      database: process.env.DB_NAME ?? 'knightsrook_persona',
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      waitForConnections: true,
      connectionLimit: 5,
    })

    this.pg = new pg.Pool({
      host: process.env.PG_HOST ?? '127.0.0.1',
      port: Number(process.env.PG_PORT ?? 5433),
      database: process.env.PG_DB ?? 'persona',
      user: process.env.PG_USER ?? 'persona',
      password: process.env.PG_PASS ?? 'persona',
    })

    await this.migrateMysql()
    await this.migratePostgres()
  }

  async ensureReady() {
    await this.ready
  }

  private async migrateMysql() {
    await this.mysql.execute(`
      CREATE TABLE IF NOT EXISTS turns (
        id VARCHAR(26) PRIMARY KEY,
        persona_id VARCHAR(64) NOT NULL DEFAULT 'default',
        role VARCHAR(10) NOT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'human',
        content TEXT NOT NULL,
        raw_llm_content TEXT,
        cohesion_score TINYINT,
        cohesion_drivers TEXT,
        cohesion_shifts TEXT,
        importance_entities JSON,
        importance_facts JSON,
        importance_preferences JSON,
        importance_decisions JSON,
        normalization_contradictions JSON,
        normalization_additions JSON,
        retrieval_cohesion_count INT,
        retrieval_cohesion_sims JSON,
        retrieval_factual_count INT,
        tokens INT NOT NULL,
        timestamp BIGINT NOT NULL,
        INDEX idx_turns_persona (persona_id)
      )
    `)

    // Additive column migrations — safe to run repeatedly on existing tables
    await this.addColumnIfMissing('source', `VARCHAR(16) NOT NULL DEFAULT 'human'`, 'AFTER role')
    await this.addColumnIfMissing('retrieval_cohesion_count', 'INT', 'AFTER normalization_additions')
    await this.addColumnIfMissing('retrieval_cohesion_sims', 'JSON', 'AFTER retrieval_cohesion_count')
    await this.addColumnIfMissing('retrieval_factual_count', 'INT', 'AFTER retrieval_cohesion_sims')
  }

  private async migratePostgres(): Promise<void> {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS persona_meta (
        persona_id VARCHAR(64) NOT NULL,
        key        VARCHAR(64) NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (persona_id, key)
      )
    `)
    await this.pg.query(`
      ALTER TABLE consolidated_memories
        ADD COLUMN IF NOT EXISTS confidence FLOAT NOT NULL DEFAULT 0.0
    `)
    // Backfill confidence from cohesion_peak for memories still at default 0.0
    await this.pg.query(`
      UPDATE consolidated_memories
        SET confidence = ROUND((cohesion_peak / 10.0)::numeric, 2)
        WHERE persona_id = $1 AND confidence = 0.0 AND cohesion_peak > 0
    `, [this.personaId])
    await this.pg.query(`
      ALTER TABLE consolidated_memories
        ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'conversation'
    `)
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS memory_edges (
        id         VARCHAR(26) PRIMARY KEY,
        persona_id VARCHAR(64) NOT NULL,
        from_id    VARCHAR(26) NOT NULL,
        to_id      VARCHAR(26) NOT NULL,
        weight     FLOAT NOT NULL DEFAULT 0.5,
        source     VARCHAR(16) NOT NULL DEFAULT 'dream',
        use_count  INT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        last_used  BIGINT,
        UNIQUE (persona_id, from_id, to_id)
      )
    `)
    await this.pg.query(`
      CREATE INDEX IF NOT EXISTS memory_edges_from ON memory_edges (persona_id, from_id)
    `)
    await this.pg.query(`
      CREATE INDEX IF NOT EXISTS memory_edges_to ON memory_edges (persona_id, to_id)
    `)
    // Backfill: mark memories as 'internal' if their turns were dream/goblin cycles.
    // Checks MySQL turns table for source='internal' and syncs to Postgres.
    try {
      const [internalTurns] = await this.mysql.query<any[]>(
        `SELECT id FROM turns WHERE persona_id = ? AND source = 'internal'`,
        [this.personaId]
      )
      if (internalTurns.length > 0) {
        const ids = internalTurns.map((r: any) => r.id)
        // Any memory whose turn_ids overlap with internal turn ids gets marked internal
        await this.pg.query(`
          UPDATE consolidated_memories
          SET source = 'internal'
          WHERE persona_id = $1
            AND source = 'conversation'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(turn_ids) t
              WHERE t = ANY($2::text[])
            )
        `, [this.personaId, ids])
      }
    } catch (e) {
      console.warn('[storage] backfill source failed (non-fatal):', e)
    }
  }

  private async addColumnIfMissing(column: string, definition: string, position: string): Promise<void> {
    const [rows] = await this.mysql.query<any[]>(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turns' AND COLUMN_NAME = ?`,
      [column]
    )
    if (rows.length === 0) {
      await this.mysql.execute(`ALTER TABLE turns ADD COLUMN ${column} ${definition} ${position}`)
    }
  }

  async saveTurn(turn: Turn): Promise<void> {
    await this.mysql.execute(
      `INSERT INTO turns (
        id, persona_id, role, source, content, raw_llm_content,
        cohesion_score, cohesion_drivers, cohesion_shifts,
        importance_entities, importance_facts, importance_preferences, importance_decisions,
        normalization_contradictions, normalization_additions,
        retrieval_cohesion_count, retrieval_cohesion_sims, retrieval_factual_count,
        tokens, timestamp
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [
        turn.id, this.personaId, turn.role, turn.source, turn.content, turn.rawLLMContent ?? null,
        turn.cohesion?.score ?? null, turn.cohesion?.drivers ?? null, turn.cohesion?.shifts ?? null,
        JSON.stringify(turn.importance?.entities ?? []),
        JSON.stringify(turn.importance?.facts ?? []),
        JSON.stringify(turn.importance?.preferences ?? []),
        JSON.stringify(turn.importance?.decisions ?? []),
        JSON.stringify(turn.normalizationApplied?.contradictionsFound ?? []),
        JSON.stringify(turn.normalizationApplied?.additionsIntegrated ?? []),
        turn.retrieval?.cohesionCount ?? null,
        turn.retrieval ? JSON.stringify(turn.retrieval.cohesionSims) : null,
        turn.retrieval?.factualCount ?? null,
        turn.tokens, turn.timestamp,
      ]
    )
    writeFileSync(join(this.archiveDir, `${turn.id}.json`), JSON.stringify(turn, null, 2))
  }

  // Durable cohesion coverage — counts persisted assistant turns with/without a
  // rating. User turns are excluded (they're never rated). Seeds the substrate's
  // counters at startup so coverage reflects the persona's whole lifetime, not
  // just the current process.
  async cohesionCoverage(): Promise<{ rated: number; unrated: number }> {
    await this.ready
    const [rows] = await this.mysql.query<any[]>(
      `SELECT
         SUM(cohesion_score IS NOT NULL) AS rated,
         SUM(cohesion_score IS NULL)     AS unrated
       FROM turns
       WHERE persona_id = ? AND role = 'assistant'`,
      [this.personaId]
    )
    const row = rows[0] ?? {}
    return { rated: Number(row.rated ?? 0), unrated: Number(row.unrated ?? 0) }
  }

  // All turns for this persona, oldest first. Used by the backfill to replay
  // captured-but-never-consolidated exchanges.
  async loadTurns(): Promise<Turn[]> {
    await this.ready
    const [rows] = await this.mysql.query<any[]>(
      `SELECT * FROM turns WHERE persona_id = ? ORDER BY timestamp ASC, id ASC`,
      [this.personaId]
    )
    return rows.map(this.rowToTurn)
  }

  // Turn IDs already folded into a consolidated memory — so the backfill (and
  // the eviction invariant) can skip anything already weighted in Postgres.
  async consolidatedTurnIds(): Promise<Set<string>> {
    await this.ready
    const { rows } = await this.pg.query(
      `SELECT turn_ids FROM consolidated_memories WHERE persona_id = $1`,
      [this.personaId]
    )
    const ids = new Set<string>()
    for (const r of rows) {
      const arr = typeof r.turn_ids === 'string' ? JSON.parse(r.turn_ids) : r.turn_ids
      for (const id of arr ?? []) ids.add(id)
    }
    return ids
  }

  private rowToTurn = (row: any): Turn => ({
    id: row.id,
    role: row.role,
    source: (row.source ?? (row.role === 'user' ? 'human' : 'self')) as Turn['source'],
    content: row.content,
    rawLLMContent: row.raw_llm_content ?? undefined,
    cohesion: row.cohesion_score == null ? undefined : {
      score: row.cohesion_score,
      drivers: row.cohesion_drivers ?? '',
      shifts: row.cohesion_shifts ?? '',
    },
    importance: {
      entities: this.parseJsonArr(row.importance_entities),
      facts: this.parseJsonArr(row.importance_facts),
      preferences: this.parseJsonArr(row.importance_preferences),
      decisions: this.parseJsonArr(row.importance_decisions),
    },
    tokens: row.tokens,
    timestamp: Number(row.timestamp),
  })

  private parseJsonArr(v: any): string[] {
    if (Array.isArray(v)) return v
    if (typeof v === 'string') { try { return JSON.parse(v) } catch { return [] } }
    return []
  }

  async saveMemory(memory: ConsolidatedMemory, embedding: number[]): Promise<void> {
    const vec = `[${embedding.join(',')}]`
    await this.pg.query(
      `INSERT INTO consolidated_memories (
        id, persona_id, cluster, turn_ids, summary, embedding, cohesion_peak,
        merged_entities, merged_facts, merged_preferences, merged_decisions,
        tier, last_retrieved, retrieval_count, confidence, source, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary`,
      [
        memory.id, this.personaId, memory.cluster,
        JSON.stringify(memory.turnIds), memory.summary, vec, memory.cohesionPeak,
        JSON.stringify(memory.mergedEntities), JSON.stringify(memory.mergedFacts),
        JSON.stringify(memory.mergedPreferences), JSON.stringify(memory.mergedDecisions),
        memory.tier, memory.lastRetrieved, memory.retrievalCount, memory.confidence ?? 0.0,
        memory.source ?? 'conversation', memory.createdAt,
      ]
    )
  }

  // Cohesion retrieval — two-pass with wide-net fallback.
  //
  // Pass 1: blended score (70% cosine + 30% recency over 7 days), top `limit`.
  // Pass 2: if the best result is weak (similarity < 0.45 — topic divergence,
  //   pivot, non-sequitur), fall back to recency-only: pull the 5 most recent
  //   high-cohesion memories regardless of topic distance. Merged with pass 1,
  //   deduped by id, capped at limit.
  //
  // This handles unexpected correlations and cold re-entry on a changed topic
  // without requiring a graph of cross-domain edges (which the dream state will
  // eventually build organically).
  async retrieveCohesionWeighted(queryEmbedding: number[], limit = 10): Promise<RetrievedMemory[]> {
    const vec = `[${queryEmbedding.join(',')}]`
    const now = Date.now()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000

    const { rows } = await this.pg.query(
      `SELECT *,
              1 - (embedding <=> $1::vector) AS similarity,
              GREATEST(0.0, 1.0 - ($3::float - created_at) / $4::float) AS recency_score
       FROM consolidated_memories
       WHERE persona_id = $2 AND embedding IS NOT NULL
       ORDER BY 0.7 * (1 - (embedding <=> $1::vector))
              + 0.3 * GREATEST(0.0, 1.0 - ($3::float - created_at) / $4::float) DESC
       LIMIT $5`,
      [vec, this.personaId, now, sevenDaysMs, limit]
    )

    let allRows = [...rows]

    // Wide-net fallback: if top result is below similarity threshold, no
    // topical match — cast wider by pulling recent high-cohesion memories.
    const bestSimilarity = rows.length > 0 ? Number(rows[0].similarity) : 0
    if (bestSimilarity < 0.45) {
      const { rows: recentRows } = await this.pg.query(
        `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
         FROM consolidated_memories
         WHERE persona_id = $2 AND embedding IS NOT NULL
         ORDER BY cohesion_peak DESC, created_at DESC
         LIMIT 5`,
        [vec, this.personaId]
      )
      const seen = new Set(allRows.map((r: any) => r.id))
      for (const r of recentRows) {
        if (!seen.has(r.id)) { allRows.push(r); seen.add(r.id) }
      }
      allRows = allRows.slice(0, limit)
    }

    if (allRows.length > 0) {
      const ids = allRows.map((r: any) => r.id)
      const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(',')
      await this.pg.query(
        `UPDATE consolidated_memories
         SET last_retrieved = $1, retrieval_count = retrieval_count + 1
         WHERE id IN (${placeholders})`,
        [Date.now(), ...ids]
      )
    }

    return allRows.map((r: any) => ({ ...this.rowToMemory(r), similarity: Number(r.similarity) }))
  }

  // Factual retrieval — keyword overlap, persona-scoped
  async retrieveByImportance(query: string, limit = 5): Promise<RetrievedMemory[]> {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    if (keywords.length === 0) return []

    const { rows } = await this.pg.query(
      `SELECT * FROM consolidated_memories WHERE persona_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [this.personaId, limit * 4]
    )

    const scored = rows
      .map((r: any) => {
        const mem = this.rowToMemory(r)
        const haystack = [
          ...mem.mergedEntities, ...mem.mergedFacts,
          ...mem.mergedPreferences, ...mem.mergedDecisions,
          mem.summary,
        ].join(' ').toLowerCase()
        const hits = keywords.filter(k => haystack.includes(k)).length
        return { mem, hits }
      })
      .filter(({ hits }: any) => hits > 0)
      .sort((a: any, b: any) => b.hits - a.hits)
      .slice(0, limit)

    return scored.map(({ mem, hits }: any) => ({ ...mem, keywordHits: hits }))
  }

  // Dream seed — biased toward low-confidence memories (things not yet well understood).
  // Picks from the bottom 40% by confidence with random tie-breaking, so high-confidence
  // nodes can still be selected but are deprioritized as entry points.
  async retrieveDreamSeed(): Promise<ConsolidatedMemory | null> {
    const { rows } = await this.pg.query(
      `SELECT * FROM (
         SELECT * FROM consolidated_memories
         WHERE persona_id = $1 AND embedding IS NOT NULL
         ORDER BY confidence ASC, RANDOM()
         LIMIT GREATEST(1, (SELECT COUNT(*) FROM consolidated_memories WHERE persona_id = $1) * 2 / 5)
       ) sub
       ORDER BY RANDOM()
       LIMIT 1`,
      [this.personaId]
    )
    return rows.length > 0 ? this.rowToMemory(rows[0]) : null
  }

  // Adjust confidence of a memory after a dream chain step.
  // delta > 0: step was high-cohesion, memory is well-integrated.
  // delta < 0: step was low-cohesion or produced contradiction.
  // Clamped to [0, 1]. Applies a small decay each call so confidence erodes without reinforcement.
  async updateConfidence(id: string, delta: number): Promise<void> {
    const DECAY = 0.005
    await this.pg.query(
      `UPDATE consolidated_memories
       SET confidence = GREATEST(0.0, LEAST(1.0, confidence + $1 - $2))
       WHERE id = $3`,
      [delta, DECAY, id]
    )
  }

  // Returns memories that have never been visited by the dream chain (confidence=0,
  // retrieval_count=0), randomly ordered so each call surfaces different gaps.
  async confidenceStats(): Promise<{ avg: number; explored: number; total: number }> {
    const { rows } = await this.pg.query(
      `SELECT ROUND(AVG(confidence)::numeric, 4) as avg,
              SUM(CASE WHEN confidence > 0 THEN 1 ELSE 0 END) as explored,
              COUNT(*) as total
       FROM consolidated_memories WHERE persona_id = $1`,
      [this.personaId]
    )
    const r = rows[0]
    return { avg: Number(r.avg ?? 0), explored: Number(r.explored ?? 0), total: Number(r.total ?? 0) }
  }

  async retrieveUnexplored(limit = 3): Promise<ConsolidatedMemory[]> {
    const { rows } = await this.pg.query(
      `SELECT * FROM consolidated_memories
       WHERE persona_id = $1 AND confidence = 0 AND retrieval_count = 0 AND embedding IS NOT NULL
       ORDER BY RANDOM() LIMIT $2`,
      [this.personaId, limit]
    )
    return rows.map((r: any) => this.rowToMemory(r))
  }

  // ── Edge layer ────────────────────────────────────────────────────────────────

  // Record a traversal between two nodes. If the edge already exists, update
  // weight (moving average toward new cohesion signal) and increment use_count.
  async upsertEdge(fromId: string, toId: string, cohesion: number, source: 'dream' | 'goblin' | 'retrieval'): Promise<void> {
    const { ulid } = await import('ulid')
    const weight = cohesion / 10
    await this.pg.query(
      `INSERT INTO memory_edges (id, persona_id, from_id, to_id, weight, source, use_count, created_at, last_used)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7)
       ON CONFLICT (persona_id, from_id, to_id) DO UPDATE
         SET weight    = (memory_edges.weight * memory_edges.use_count + EXCLUDED.weight) / (memory_edges.use_count + 1),
             use_count = memory_edges.use_count + 1,
             last_used = EXCLUDED.last_used`,
      [ulid(), this.personaId, fromId, toId, weight, source, Date.now()]
    )
  }

  // Returns adjacent nodes from stored edges, penalizing over-used edges to
  // break gravity wells. Excludes already-visited nodes.
  async getAdjacentByEdge(nodeId: string, excludeIds: string[], limit = 4): Promise<ConsolidatedMemory[]> {
    const excludePlaceholders = excludeIds.length
      ? `AND cm.id NOT IN (${excludeIds.map((_, i) => `$${i + 3}`).join(',')})`
      : ''
    // Score = weight / log(use_count + 2) — penalizes over-traversed edges
    const { rows } = await this.pg.query(
      `SELECT cm.*, me.weight, me.use_count,
              me.weight / LOG(me.use_count + 2) AS traversal_score
       FROM memory_edges me
       JOIN consolidated_memories cm ON cm.id = me.to_id
       WHERE me.persona_id = $1 AND me.from_id = $2
         AND cm.embedding IS NOT NULL
         ${excludePlaceholders}
       ORDER BY traversal_score DESC
       LIMIT ${limit}`,
      [this.personaId, nodeId, ...excludeIds]
    )
    return rows.map((r: any) => this.rowToMemory(r))
  }

  // Orphan nodes — memories with no edges at all. Primary goblin target list.
  async retrieveOrphans(limit = 3): Promise<ConsolidatedMemory[]> {
    const { rows } = await this.pg.query(
      `SELECT * FROM consolidated_memories
       WHERE persona_id = $1
         AND embedding IS NOT NULL
         AND id NOT IN (
           SELECT from_id FROM memory_edges WHERE persona_id = $1
           UNION
           SELECT to_id   FROM memory_edges WHERE persona_id = $1
         )
       ORDER BY RANDOM() LIMIT $2`,
      [this.personaId, limit]
    )
    return rows.map((r: any) => this.rowToMemory(r))
  }

  // Edge stats — for UI and diagnostics
  async edgeStats(): Promise<{ total: number; orphans: number; maxUse: number; avgWeight: number }> {
    const [edgeRes, orphanRes] = await Promise.all([
      this.pg.query(
        `SELECT COUNT(*) as total, MAX(use_count) as max_use, ROUND(AVG(weight)::numeric, 3) as avg_weight
         FROM memory_edges WHERE persona_id = $1`,
        [this.personaId]
      ),
      this.pg.query(
        `SELECT COUNT(*) as orphans FROM consolidated_memories
         WHERE persona_id = $1 AND embedding IS NOT NULL
           AND id NOT IN (
             SELECT from_id FROM memory_edges WHERE persona_id = $1
             UNION SELECT to_id FROM memory_edges WHERE persona_id = $1
           )`,
        [this.personaId]
      ),
    ])
    const e = edgeRes.rows[0]
    return {
      total: Number(e.total ?? 0),
      orphans: Number(orphanRes.rows[0].orphans ?? 0),
      maxUse: Number(e.max_use ?? 0),
      avgWeight: Number(e.avg_weight ?? 0),
    }
  }

  async searchMemories(opts: {
    q: string; source: string; from: number; to: number; limit: number; offset: number
  }): Promise<{ memories: ConsolidatedMemory[]; total: number }> {
    const conditions: string[] = ['persona_id = $1', 'created_at BETWEEN $2 AND $3']
    const params: any[] = [this.personaId, opts.from, opts.to]
    let i = 4
    if (opts.source) { conditions.push(`source = $${i++}`); params.push(opts.source) }
    if (opts.q) {
      conditions.push(`(summary ILIKE $${i} OR cluster ILIKE $${i})`)
      params.push(`%${opts.q}%`); i++
    }
    const where = conditions.join(' AND ')
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.pg.query(`SELECT COUNT(*) as total FROM consolidated_memories WHERE ${where}`, params),
      this.pg.query(
        `SELECT * FROM consolidated_memories WHERE ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`,
        [...params, opts.limit, opts.offset]
      ),
    ])
    return { memories: rows.map((r: any) => this.rowToMemory(r)), total: Number(countRows[0].total) }
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.pg.query(
      `SELECT value FROM persona_meta WHERE persona_id = $1 AND key = $2`,
      [this.personaId, key]
    )
    return result.rows[0]?.value ?? null
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO persona_meta (persona_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (persona_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.personaId, key, value]
    )
  }

  // Nearest neighbours to a given embedding — used by the dream chain to find
  // what naturally connects to the current node.
  async retrieveNearestTo(embedding: number[], excludeIds: string[], limit = 4): Promise<ConsolidatedMemory[]> {
    const vec = `[${embedding.join(',')}]`
    const excludePlaceholders = excludeIds.length
      ? `AND id NOT IN (${excludeIds.map((_, i) => `$${i + 3}`).join(',')})`
      : ''
    const { rows } = await this.pg.query(
      `SELECT * FROM consolidated_memories
       WHERE persona_id = $1 AND embedding IS NOT NULL
       ${excludePlaceholders}
       ORDER BY embedding <=> $2::vector
       LIMIT ${limit}`,
      [this.personaId, vec, ...excludeIds]
    )
    return rows.map((r: any) => this.rowToMemory(r))
  }

  private rowToMemory = (row: any): ConsolidatedMemory => ({
    id: row.id,
    cluster: row.cluster,
    turnIds: typeof row.turn_ids === 'string' ? JSON.parse(row.turn_ids) : row.turn_ids,
    summary: row.summary,
    cohesionPeak: row.cohesion_peak,
    mergedEntities: typeof row.merged_entities === 'string' ? JSON.parse(row.merged_entities) : (row.merged_entities ?? []),
    mergedFacts: typeof row.merged_facts === 'string' ? JSON.parse(row.merged_facts) : (row.merged_facts ?? []),
    mergedPreferences: typeof row.merged_preferences === 'string' ? JSON.parse(row.merged_preferences) : (row.merged_preferences ?? []),
    mergedDecisions: typeof row.merged_decisions === 'string' ? JSON.parse(row.merged_decisions) : (row.merged_decisions ?? []),
    tier: row.tier,
    lastRetrieved: row.last_retrieved,
    retrievalCount: row.retrieval_count,
    confidence: Number(row.confidence ?? 0),
    source: (row.source ?? 'conversation') as 'conversation' | 'internal',
    createdAt: Number(row.created_at),
  })
}
