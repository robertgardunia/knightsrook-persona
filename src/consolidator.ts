import Anthropic from '@anthropic-ai/sdk'
import { ulid } from 'ulid'
import type { Turn, ConsolidatedMemory, ConsolidationTelemetry } from './types.js'
import { CONSOLIDATION_PROMPT } from './prompts.js'
import { mergeImportance } from './importance.js'
import { embedText } from './embeddings.js'

export async function consolidate(
  client: Anthropic,
  model: string,
  buffer: Turn[],
  storage: import('./storage.js').Storage
): Promise<{ buffer: Turn[]; telemetry: ConsolidationTelemetry }> {
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
    messages: [{ role: 'user', content: CONSOLIDATION_PROMPT + JSON.stringify(bufferDump, null, 2) }],
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
    const highIds = buffer.filter(t => (t.cohesion?.score ?? 0) >= 8).map(t => t.id)
    const lowTurns = buffer.filter(t => (t.cohesion?.score ?? 10) < 8)
    decision = {
      preserve: highIds,
      summarize: lowTurns.length > 0 ? [{
        cluster: 'general',
        turn_ids: lowTurns.map(t => t.id),
        summary: lowTurns.map(t => t.content.slice(0, 120)).join(' | '),
      }] : [],
      drop: [],
    }
  }

  const preserveSet = new Set(decision.preserve)
  const telemetryClusters = []

  for (const cluster of decision.summarize) {
    const clusterTurns = buffer.filter(t => cluster.turn_ids.includes(t.id))
    const cohesionPeak = Math.max(...clusterTurns.map(t => t.cohesion?.score ?? 0), 0)
    const merged = mergeImportance(
      clusterTurns.map(t => t.importance ?? { entities: [], facts: [], preferences: [], decisions: [] })
    )

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

    const embedding = await embedText(cluster.summary)
    await storage.saveMemory(memory, embedding)

    telemetryClusters.push({
      cluster: cluster.cluster,
      turnCount: clusterTurns.length,
      cohesionPeak,
      tier: memory.tier,
    })
  }

  const newBuffer = buffer.filter(t => preserveSet.has(t.id))

  const telemetry: ConsolidationTelemetry = {
    triggered: true,
    bufferTokensBefore: buffer.reduce((s, t) => s + t.tokens, 0),
    bufferTokensAfter: newBuffer.reduce((s, t) => s + t.tokens, 0),
    preserved: decision.preserve.length,
    summarized: telemetryClusters,
    dropped: decision.drop.length,
  }

  return { buffer: newBuffer, telemetry }
}
