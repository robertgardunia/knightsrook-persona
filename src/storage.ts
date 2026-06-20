import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Turn, ConsolidatedMemory } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const ARCHIVE_DIR = join(DATA_DIR, 'archive')
const DB_PATH = join(DATA_DIR, 'persona.db')

export class Storage {
  private db: Database.Database

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true })
    mkdirSync(ARCHIVE_DIR, { recursive: true })
    this.db = new Database(DB_PATH)
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_llm_content TEXT,
        cohesion_score INTEGER,
        cohesion_drivers TEXT,
        cohesion_shifts TEXT,
        importance_entities TEXT,
        importance_facts TEXT,
        importance_preferences TEXT,
        importance_decisions TEXT,
        normalization_contradictions TEXT,
        normalization_additions TEXT,
        tokens INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consolidated_memories (
        id TEXT PRIMARY KEY,
        cluster TEXT NOT NULL,
        turn_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        cohesion_peak INTEGER NOT NULL,
        merged_entities TEXT,
        merged_facts TEXT,
        merged_preferences TEXT,
        merged_decisions TEXT,
        tier TEXT NOT NULL DEFAULT 'warm',
        last_retrieved INTEGER,
        retrieval_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_tier ON consolidated_memories(tier);
      CREATE INDEX IF NOT EXISTS idx_memories_cohesion ON consolidated_memories(cohesion_peak);
    `)
  }

  saveTurn(turn: Turn) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO turns (
        id, role, content, raw_llm_content,
        cohesion_score, cohesion_drivers, cohesion_shifts,
        importance_entities, importance_facts, importance_preferences, importance_decisions,
        normalization_contradictions, normalization_additions,
        tokens, timestamp
      ) VALUES (
        @id, @role, @content, @rawLLMContent,
        @cohesionScore, @cohesionDrivers, @cohesionShifts,
        @importanceEntities, @importanceFacts, @importancePreferences, @importanceDecisions,
        @normContradictions, @normAdditions,
        @tokens, @timestamp
      )
    `)
    stmt.run({
      id: turn.id,
      role: turn.role,
      content: turn.content,
      rawLLMContent: turn.rawLLMContent ?? null,
      cohesionScore: turn.cohesion?.score ?? null,
      cohesionDrivers: turn.cohesion?.drivers ?? null,
      cohesionShifts: turn.cohesion?.shifts ?? null,
      importanceEntities: JSON.stringify(turn.importance?.entities ?? []),
      importanceFacts: JSON.stringify(turn.importance?.facts ?? []),
      importancePreferences: JSON.stringify(turn.importance?.preferences ?? []),
      importanceDecisions: JSON.stringify(turn.importance?.decisions ?? []),
      normContradictions: JSON.stringify(turn.normalizationApplied?.contradictionsFound ?? []),
      normAdditions: JSON.stringify(turn.normalizationApplied?.additionsIntegrated ?? []),
      tokens: turn.tokens,
      timestamp: turn.timestamp,
    })
    // Full-fidelity archive — never deleted
    writeFileSync(join(ARCHIVE_DIR, `${turn.id}.json`), JSON.stringify(turn, null, 2))
  }

  saveMemory(memory: ConsolidatedMemory) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO consolidated_memories (
        id, cluster, turn_ids, summary, cohesion_peak,
        merged_entities, merged_facts, merged_preferences, merged_decisions,
        tier, last_retrieved, retrieval_count, created_at
      ) VALUES (
        @id, @cluster, @turnIds, @summary, @cohesionPeak,
        @mergedEntities, @mergedFacts, @mergedPreferences, @mergedDecisions,
        @tier, @lastRetrieved, @retrievalCount, @createdAt
      )
    `)
    stmt.run({
      id: memory.id,
      cluster: memory.cluster,
      turnIds: JSON.stringify(memory.turnIds),
      summary: memory.summary,
      cohesionPeak: memory.cohesionPeak,
      mergedEntities: JSON.stringify(memory.mergedEntities),
      mergedFacts: JSON.stringify(memory.mergedFacts),
      mergedPreferences: JSON.stringify(memory.mergedPreferences),
      mergedDecisions: JSON.stringify(memory.mergedDecisions),
      tier: memory.tier,
      lastRetrieved: memory.lastRetrieved,
      retrievalCount: memory.retrievalCount,
      createdAt: memory.createdAt,
    })
  }

  retrieveCohesionWeighted(query: string, limit = 5): ConsolidatedMemory[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    if (keywords.length === 0) {
      const rows = this.db.prepare(
        `SELECT * FROM consolidated_memories ORDER BY cohesion_peak DESC, created_at DESC LIMIT ?`
      ).all(limit) as any[]
      return rows.map(this.rowToMemory)
    }

    const conditions = keywords.map(() => `LOWER(summary) LIKE ?`).join(' OR ')
    const params = keywords.map(k => `%${k}%`)
    const rows = this.db.prepare(
      `SELECT * FROM consolidated_memories
       WHERE ${conditions}
       ORDER BY cohesion_peak DESC, created_at DESC
       LIMIT ?`
    ).all(...params, limit) as any[]

    this.db.prepare(
      `UPDATE consolidated_memories SET last_retrieved = ?, retrieval_count = retrieval_count + 1
       WHERE id IN (${rows.map(() => '?').join(',')})`
    ).run(Date.now(), ...rows.map((r: any) => r.id))

    return rows.map(this.rowToMemory)
  }

  retrieveByImportance(query: string, limit = 5): ConsolidatedMemory[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    if (keywords.length === 0) return []

    const conditions = keywords.map(() =>
      `(LOWER(merged_entities) LIKE ? OR LOWER(merged_facts) LIKE ? OR LOWER(merged_decisions) LIKE ?)`
    ).join(' OR ')
    const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`])

    const rows = this.db.prepare(
      `SELECT * FROM consolidated_memories
       WHERE ${conditions}
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(...params, limit) as any[]

    return rows.map(this.rowToMemory)
  }

  recentConsolidated(limit = 3): ConsolidatedMemory[] {
    const rows = this.db.prepare(
      `SELECT * FROM consolidated_memories ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[]
    return rows.map(this.rowToMemory)
  }

  private rowToMemory(row: any): ConsolidatedMemory {
    return {
      id: row.id,
      cluster: row.cluster,
      turnIds: JSON.parse(row.turn_ids),
      summary: row.summary,
      cohesionPeak: row.cohesion_peak,
      mergedEntities: JSON.parse(row.merged_entities ?? '[]'),
      mergedFacts: JSON.parse(row.merged_facts ?? '[]'),
      mergedPreferences: JSON.parse(row.merged_preferences ?? '[]'),
      mergedDecisions: JSON.parse(row.merged_decisions ?? '[]'),
      tier: row.tier,
      lastRetrieved: row.last_retrieved,
      retrievalCount: row.retrieval_count,
      createdAt: row.created_at,
    }
  }
}
