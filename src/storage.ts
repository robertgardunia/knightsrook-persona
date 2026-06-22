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
        tier, last_retrieved, retrieval_count, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary`,
      [
        memory.id, this.personaId, memory.cluster,
        JSON.stringify(memory.turnIds), memory.summary, vec, memory.cohesionPeak,
        JSON.stringify(memory.mergedEntities), JSON.stringify(memory.mergedFacts),
        JSON.stringify(memory.mergedPreferences), JSON.stringify(memory.mergedDecisions),
        memory.tier, memory.lastRetrieved, memory.retrievalCount, memory.createdAt,
      ]
    )
  }

  // Cohesion retrieval — cosine similarity, persona-scoped
  async retrieveCohesionWeighted(queryEmbedding: number[], limit = 5): Promise<RetrievedMemory[]> {
    const vec = `[${queryEmbedding.join(',')}]`
    const { rows } = await this.pg.query(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM consolidated_memories
       WHERE persona_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vec, this.personaId, limit]
    )

    if (rows.length > 0) {
      const ids = rows.map((r: any) => r.id)
      const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(',')
      await this.pg.query(
        `UPDATE consolidated_memories
         SET last_retrieved = $1, retrieval_count = retrieval_count + 1
         WHERE id IN (${placeholders})`,
        [Date.now(), ...ids]
      )
    }

    return rows.map((r: any) => ({ ...this.rowToMemory(r), similarity: Number(r.similarity) }))
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
    createdAt: row.created_at,
  })
}
