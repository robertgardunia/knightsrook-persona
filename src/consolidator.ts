import { ulid } from 'ulid'
import type { Turn, ConsolidatedMemory, ConsolidationCluster } from './types.js'
import { mergeImportance } from './importance.js'
import { embedText } from './embeddings.js'

// Per-response capture. Runs every turn.
//
// The division of labor is fixed: the INSTANCE already judged this exchange's
// cohesion in-band (score + drivers + shifts). That judgment — including the
// characterization of WHAT mattered — is irreplaceable and is treated as
// ground truth. We deliberately do NOT route it through a local model to
// "summarize": a small model can only degrade an already-accurate, zero-risk
// description or hallucinate around it, and the summary is both what gets
// embedded (drives retrieval) and what gets injected back as identity context.
// So the memory text IS the instance's own drivers/shifts. Ollama only embeds.
//
// Bucketing (tier) is deterministic code, not a model decision: the score the
// instance gave IS the weight.
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

  // Summary = the instance's own in-band characterization. No model call, no
  // paraphrase, no hallucination surface. drivers leads (what produced the
  // cohesion); shifts follows (what changed).
  const summary = cohesion.shifts
    ? `${cohesion.drivers} — shift: ${cohesion.shifts}`
    : cohesion.drivers

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
    confidence: 0.0,
    source: assistantTurn.source === 'internal' ? 'internal' : 'conversation',
    createdAt: Date.now(),
  }

  const embedding = await embedText(summary)
  await storage.saveMemory(memory, embedding)

  return {
    memory,
    cluster: { cluster, turnCount: 2, cohesionPeak: peak, tier },
  }
}
