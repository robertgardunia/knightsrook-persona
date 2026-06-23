import type { CohesionRating } from './types.js'

const COHESION_RE = /<cohesion>([\s\S]*?)<\/cohesion>/

// No fallback score. A missing or malformed block yields `null` — an honest
// absence of signal — never a fabricated neutral rating. Injecting a fake 5
// would poison consolidation (which weights turns by cohesion) with noise the
// model never actually produced. The substrate re-prompts for the block
// instead; see Substrate.respond.
export function parseCohesion(raw: string): { visible: string; cohesion: CohesionRating | null } {
  const match = raw.match(COHESION_RE)
  if (!match) return { visible: raw.trim(), cohesion: null }

  const visible = raw.replace(COHESION_RE, '').trim()
  try {
    const parsed = JSON.parse(match[1].trim())
    const score = Number(parsed.score)
    if (!Number.isFinite(score) || score < 1 || score > 10) {
      return { visible, cohesion: null }
    }
    const cohesion: CohesionRating = {
      score,
      drivers: String(parsed.drivers ?? ''),
      shifts: String(parsed.shifts ?? ''),
    }
    return { visible, cohesion }
  } catch {
    return { visible, cohesion: null }
  }
}

const RECALL_RE = /<recall>([\s\S]*?)<\/recall>/

// Parse the recall block — a list of memory cluster labels the model drew from.
// Returns null if the block is missing or malformed.
export function parseRecall(raw: string): { visible: string; recalled: string[] | null } {
  const match = raw.match(RECALL_RE)
  if (!match) return { visible: raw.trim(), recalled: null }
  const visible = raw.replace(RECALL_RE, '').trim()
  try {
    const parsed = JSON.parse(match[1].trim())
    if (!Array.isArray(parsed)) return { visible, recalled: null }
    return { visible, recalled: parsed.map(String) }
  } catch {
    return { visible, recalled: null }
  }
}

// Check whether at least one recalled cluster matches an injected cluster.
export function validateRecall(recalled: string[], injectedClusters: string[]): boolean {
  if (recalled.length === 0) return false
  return recalled.some(r => injectedClusters.some(c => c.toLowerCase().includes(r.toLowerCase()) || r.toLowerCase().includes(c.toLowerCase())))
}

export function formatCohesionBanner(cohesion: CohesionRating | undefined): string {
  if (!cohesion) return '[Cohesion: parse failed]'
  const bar = '█'.repeat(cohesion.score) + '░'.repeat(10 - cohesion.score)
  return `[Cohesion ${cohesion.score}/10 ${bar}] ${cohesion.drivers}`
}
