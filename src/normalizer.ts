import type { NormalizationActions, ConsolidatedMemory } from './types.js'

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3))
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3))
  let hits = 0
  for (const t of ta) if (tb.has(t)) hits++
  return ta.size ? hits / ta.size : 0
}

function hasNegation(text: string): boolean {
  return /\b(?:not|no|never|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|wouldn't|can't|couldn't)\b/i.test(text)
}

export function normalize(
  candidate: string,
  userMessage: string,
  cohesionMemories: ConsolidatedMemory[],
  factualMemories: ConsolidatedMemory[]
): { normalized: string; actions: NormalizationActions } {
  const actions: NormalizationActions = {
    contradictionsFound: [],
    additionsIntegrated: [],
  }
  let working = candidate

  // CHECK 1: Contradictions against high-cohesion memories
  for (const mem of cohesionMemories) {
    const overlap = tokenOverlap(candidate, mem.summary)
    if (overlap > 0.3 && hasNegation(candidate) !== hasNegation(mem.summary)) {
      actions.contradictionsFound.push(mem.id)
      working += `\n\n[Substrate: this may contradict earlier exchange — "${mem.summary.slice(0, 120)}..."]`
    }
  }

  // CHECK 2: Missed factual relevance
  for (const mem of factualMemories) {
    const queryOverlap = tokenOverlap(userMessage, mem.summary)
    const responseOverlap = tokenOverlap(candidate, mem.summary)
    // User asked about something the substrate knows, but response didn't reference it
    if (queryOverlap > 0.25 && responseOverlap < 0.1) {
      actions.additionsIntegrated.push(mem.id)
      const snippet = mem.mergedFacts[0] ?? mem.summary.slice(0, 100)
      working += `\n\n[Substrate: also relevant from prior experience — ${snippet}]`
    }
  }

  return { normalized: working, actions }
}

export function formatNormalizationBanner(actions: NormalizationActions): string | null {
  const parts: string[] = []
  if (actions.contradictionsFound.length) parts.push(`${actions.contradictionsFound.length} contradiction(s) flagged`)
  if (actions.additionsIntegrated.length) parts.push(`${actions.additionsIntegrated.length} addition(s) integrated`)
  return parts.length ? `[Normalizer: ${parts.join(', ')}]` : null
}
