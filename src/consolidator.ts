import { ulid } from 'ulid'
import type { Turn, ConsolidatedMemory, ConsolidationCluster } from './types.js'
import { mergeImportance } from './importance.js'
import { embedText, ollamaGenerate } from './embeddings.js'

// Per-response capture. Runs every turn, entirely on the local model.
//
// The division of labor is fixed: the INSTANCE already judged this exchange's
// cohesion in-band (score + drivers + shifts). That judgment is irreplaceable
// and is treated as ground truth here. Ollama is "too dumb" to find relevancy
// and is never asked to — it only writes a summary over the instance's own
// tags and the verbatim text. Bucketing (tier) is deterministic code, not a
// model decision: the score the instance gave IS the weight.
//
// Returns null when the assistant turn carries no cohesion rating (honest
// absence) — there is nothing to weight, so nothing is stored.
export async function captureTurn(
  userTurn: Turn,
  assistantTurn: Turn,
  storage: import('./storage.js').Storage
): Promise<{ memory: ConsolidatedMemory; cluster: ConsolidationCluster } | null> {
  const cohesion = assistantTurn.cohesion
  if (!cohesion) return null

  const peak = cohesion.score
  const tier: ConsolidatedMemory['tier'] = peak >= 7 ? 'warm' : 'cold'

  // Ollama writes the summary — seeded by the instance's own drivers/shifts so
  // the local model is summarizing, not interpreting. Degrade gracefully: if
  // the local model is down, fall back to the instance's drivers + a content
  // slice. The cohesion weight is never lost, only the prose quality.
  const prompt =
    `Summarize this exchange in 2-3 sentences capturing what mattered. ` +
    `Write plainly, no preamble.\n\n` +
    `User: ${userTurn.content.slice(0, 800)}\n` +
    `Assistant: ${assistantTurn.content.slice(0, 1200)}\n\n` +
    `The assistant noted what drove this exchange's cohesion: "${cohesion.drivers}". ` +
    `What shifted: "${cohesion.shifts}".\n\nSummary:`

  let summary: string
  try {
    summary = await ollamaGenerate(prompt)
    if (!summary) throw new Error('empty summary')
  } catch {
    summary = [cohesion.drivers, cohesion.shifts, assistantTurn.content.slice(0, 200)]
      .filter(Boolean)
      .join(' — ')
  }

  // Cluster label: a short theme from the instance's drivers (no model call).
  const cluster = cohesion.drivers.split(/[—,.;]/)[0].trim().slice(0, 60) || 'exchange'

  const merged = mergeImportance([
    userTurn.importance ?? { entities: [], facts: [], preferences: [], decisions: [] },
    assistantTurn.importance ?? { entities: [], facts: [], preferences: [], decisions: [] },
  ])

  const memory: ConsolidatedMemory = {
    id: ulid(),
    cluster,
    turnIds: [userTurn.id, assistantTurn.id],
    summary,
    cohesionPeak: peak,
    mergedEntities: merged.entities,
    mergedFacts: merged.facts,
    mergedPreferences: merged.preferences,
    mergedDecisions: merged.decisions,
    tier,
    lastRetrieved: 0,
    retrievalCount: 0,
    createdAt: Date.now(),
  }

  const embedding = await embedText(summary)
  await storage.saveMemory(memory, embedding)

  return {
    memory,
    cluster: { cluster, turnCount: 2, cohesionPeak: peak, tier },
  }
}
