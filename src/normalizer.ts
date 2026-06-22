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
    }
  }

  // CHECK 2: Missed factual relevance — track silently, don't append to visible output
  for (const mem of factualMemories) {
    const queryOverlap = tokenOverlap(userMessage, mem.summary)
    const responseOverlap = tokenOverlap(candidate, mem.summary)
    if (queryOverlap > 0.25 && responseOverlap < 0.1) {
      actions.additionsIntegrated.push(mem.id)
    }
  }

  return { normalized: working, actions }
}

