/**
 * One-time backfill: replay captured-but-never-consolidated exchanges into
 * weighted Postgres memory.
 *
 * The per-turn cohesion scores already live in MySQL (capture #1 always ran).
 * What's missing — for any conversation that never crossed the old 50k-token
 * consolidation trigger — is the Postgres `consolidated_memories` rows that
 * make those scores retrievable. This script forms them, using the instance's
 * own stored cohesion scores as the weight. No re-scoring, no model judgment.
 *
 * Usage:  tsx scripts/backfill.ts <persona_id>
 */
import 'dotenv/config'
import { Storage } from '../src/storage.js'
import { captureTurn } from '../src/consolidator.js'
import type { Turn } from '../src/types.js'

const personaId = process.argv[2]
if (!personaId) {
  console.error('Usage: tsx scripts/backfill.ts <persona_id>')
  process.exit(1)
}

async function main() {
  const storage = new Storage(personaId)
  await storage.ensureReady()

  const turns = await storage.loadTurns()
  const alreadyDone = await storage.consolidatedTurnIds()

  console.log(`Persona: ${personaId}`)
  console.log(`Loaded ${turns.length} turns; ${alreadyDone.size} turn IDs already consolidated.`)

  // Pair each assistant turn with the user turn immediately preceding it.
  let formed = 0
  let skippedNull = 0
  let skippedDone = 0

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (t.role !== 'assistant') continue
    if (alreadyDone.has(t.id)) { skippedDone++; continue }
    if (!t.cohesion) { skippedNull++; continue }

    // Nearest preceding user turn (fallback: a synthetic placeholder).
    let userTurn: Turn | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (turns[j].role === 'user') { userTurn = turns[j]; break }
    }
    if (!userTurn) {
      userTurn = { id: 'backfill-missing', role: 'user', source: 'human', content: '(no paired user turn)', tokens: 0, timestamp: t.timestamp }
    }

    const result = await captureTurn(userTurn, t, storage)
    if (result) {
      formed++
      console.log(`  ✓ [${result.cluster.cohesionPeak}/10 ${result.cluster.tier}] ${result.cluster.cluster}`)
    }
  }

  console.log(`\nBackfilled ${formed} weighted memories.`)
  console.log(`Skipped: ${skippedDone} already consolidated, ${skippedNull} with no cohesion rating.`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
