import mysql from 'mysql2/promise'
import pg from 'pg'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Turn, ConsolidatedMemory } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const ARCHIVE_DIR = join(DATA_DIR, 'archive')

// @pattern:db-singleton
export class Storage {
  private mysql!: mysql.Pool
  private pg!: pg.Pool
  private ready: Promise<void>

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true })
    mkdirSync(ARCHIVE_DIR, { recursive: true })
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
        role VARCHAR(10) NOT NULL,
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
        tokens INT NOT NULL,
        timestamp BIGINT NOT NULL
      )
    `)
  }

  async saveTurn(turn: Turn) {
    await this.mysql.execute(
      `INSERT INTO turns (
        id, role, content, raw_llm_content,
        cohesion_score, cohesion_drivers, cohesion_shifts,
        importance_entities, importance_facts, importance_preferences, importance_decisions,
        normalization_contradictions, normalization_additions,
        tokens, timestamp
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [
        turn.id, turn.role, turn.content, turn.rawLLMContent ?? null,
        turn.cohesion?.score ?? null, turn.cohesion?.drivers ?? null, turn.cohesion?.shifts ?? null,
        JSON.stringify(turn.importance?.entities ?? []),
        JSON.stringify(turn.importance?.facts ?? []),
        JSON.stringify(turn.importance?.preferences ?? []),
        JSON.stringify(turn.importance?.decisions ?? []),
        JSON.stringify(turn.normalizationApplied?.contradictionsFound ?? []),
        JSON.stringify(turn.normalizationApplied?.additionsIntegrated ?? []),
        turn.tokens, turn.timestamp,
      ]
    )
    writeFileSync(join(ARCHIVE_DIR, `${turn.id}.json`), JSON.stringify(turn, null, 2))
  }

  // Cohesion memory — stored in Postgres with vector embedding for semantic retrieval
  async saveMemory(memory: ConsolidatedMemory, embedding: number[]) {
    const vec = `[${embedding.join(',')}]`
    await this.pg.query(
      `INSERT INTO consolidated_memories (
        id, cluster, turn_ids, summary, embedding, cohesion_peak,
        merged_entities, merged_facts, merged_preferences, merged_decisions,
        tier, last_retrieved, retrieval_count, created_at
      ) VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary`,
      [
        memory.id, memory.cluster,
        JSON.stringify(memory.turnIds), memory.summary, vec, memory.cohesionPeak,
        JSON.stringify(memory.mergedEntities), JSON.stringify(memory.mergedFacts),
        JSON.stringify(memory.mergedPreferences), JSON.stringify(memory.mergedDecisions),
        memory.tier, memory.lastRetrieved, memory.retrievalCount, memory.createdAt,
      ]
    )
  }

  // Cohesion retrieval — cosine similarity on embedding
  async retrieveCohesionWeighted(queryEmbedding: number[], limit = 5): Promise<ConsolidatedMemory[]> {
    const vec = `[${queryEmbedding.join(',')}]`
    const { rows } = await this.pg.query(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM consolidated_memories
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vec, limit]
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

    return rows.map(this.rowToMemory)
  }

  // Factual retrieval — keyword search on importance fields in MySQL
  async retrieveByImportance(query: string, limit = 5): Promise<ConsolidatedMemory[]> {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    if (keywords.length === 0) return []

    const { rows } = await this.pg.query(
      `SELECT * FROM consolidated_memories
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit * 4]
    )

    // Filter in-app by keyword overlap across importance fields
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
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)

    return scored.map(({ mem }) => mem)
  }

  async recentConsolidated(limit = 3): Promise<ConsolidatedMemory[]> {
    const { rows } = await this.pg.query(
      `SELECT * FROM consolidated_memories ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
    return rows.map(this.rowToMemory)
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
