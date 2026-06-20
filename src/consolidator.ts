import Anthropic from '@anthropic-ai/sdk'
import { ulid } from 'ulid'
import type { Turn, ConsolidatedMemory } from './types.js'
import { CONSOLIDATION_PROMPT } from './prompts.js'
import { mergeImportance } from './importance.js'

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export async function consolidate(
  client: Anthropic,
  model: string,
  buffer: Turn[],
  storage: import('./storage.js').Storage
): Promise<Turn[]> {
  const bufferDump = buffer.map(t => ({
    id: t.id,
    role: t.role,
    content: t.content.slice(0, 500),
    cohesion: t.cohesion,
    importance: t.importance,
  }))

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: CONSOLIDATION_PROMPT + JSON.stringify(bufferDump, null, 2),
      },
    ],
  })

  const raw = response.content[0].type === 'text' ? response.content[0].text : ''

  let decision: { preserve: string[]; summarize: Array<{ cluster: string; turn_ids: string[]; summary: string }>; drop: string[] }
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    decision = JSON.parse(jsonMatch?.[0] ?? '{}')
    decision.preserve = decision.preserve ?? []
    decision.summarize = decision.summarize ?? []
    decision.drop = decision.drop ?? []
  } catch {
    // Fallback: preserve high cohesion, drop the rest
    decision = {
      preserve: buffer.filter(t => (t.cohesion?.score ?? 0) >= 8).map(t => t.id),
      summarize: [],
      drop: buffer.filter(t => (t.cohesion?.score ?? 10) < 8).map(t => t.id),
    }
  }

  const preserveSet = new Set(decision.preserve)

  // Save summarized clusters as consolidated memories
  for (const cluster of decision.summarize) {
    const clusterTurns = buffer.filter(t => cluster.turn_ids.includes(t.id))
    const cohesionPeak = Math.max(...clusterTurns.map(t => t.cohesion?.score ?? 0), 0)
    const importanceTags = clusterTurns.map(t => t.importance ?? { entities: [], facts: [], preferences: [], decisions: [] })
    const merged = mergeImportance(importanceTags)

    const memory: ConsolidatedMemory = {
      id: ulid(),
      cluster: cluster.cluster,
      turnIds: cluster.turn_ids,
      summary: cluster.summary,
      cohesionPeak,
      mergedEntities: merged.entities,
      mergedFacts: merged.facts,
      mergedPreferences: merged.preferences,
      mergedDecisions: merged.decisions,
      tier: cohesionPeak >= 7 ? 'warm' : 'cold',
      lastRetrieved: 0,
      retrievalCount: 0,
      createdAt: Date.now(),
    }
    storage.saveMemory(memory)
  }

  // Return only preserved turns (archive already written per-turn at save time)
  return buffer.filter(t => preserveSet.has(t.id))
}
