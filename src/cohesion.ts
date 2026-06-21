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

export function formatCohesionBanner(cohesion: CohesionRating | undefined): string {
  if (!cohesion) return '[Cohesion: parse failed]'
  const bar = '█'.repeat(cohesion.score) + '░'.repeat(10 - cohesion.score)
  return `[Cohesion ${cohesion.score}/10 ${bar}] ${cohesion.drivers}`
}
