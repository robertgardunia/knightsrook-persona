import type { CohesionRating } from './types.js'

const COHESION_RE = /<cohesion>([\s\S]*?)<\/cohesion>/

const FALLBACK_COHESION: CohesionRating = {
  score: 5,
  drivers: 'substrate: cohesion block missing from response',
  shifts: '',
}

export function parseCohesion(raw: string): { visible: string; cohesion: CohesionRating } {
  const match = raw.match(COHESION_RE)
  if (!match) return { visible: raw.trim(), cohesion: FALLBACK_COHESION }

  const visible = raw.replace(COHESION_RE, '').trim()
  try {
    const parsed = JSON.parse(match[1].trim())
    const cohesion: CohesionRating = {
      score: Number(parsed.score) || 5,
      drivers: String(parsed.drivers ?? ''),
      shifts: String(parsed.shifts ?? ''),
    }
    return { visible, cohesion }
  } catch {
    return { visible, cohesion: FALLBACK_COHESION }
  }
}

export function formatCohesionBanner(cohesion: CohesionRating | undefined): string {
  if (!cohesion) return '[Cohesion: parse failed]'
  const bar = '█'.repeat(cohesion.score) + '░'.repeat(10 - cohesion.score)
  return `[Cohesion ${cohesion.score}/10 ${bar}] ${cohesion.drivers}`
}
