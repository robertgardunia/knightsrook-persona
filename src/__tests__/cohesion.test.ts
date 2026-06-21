import { describe, it, expect } from 'vitest'
import { parseCohesion, formatCohesionBanner } from '../cohesion.js'

describe('parseCohesion', () => {
  it('extracts cohesion block and strips it from visible', () => {
    const raw = `Here is my response.\n<cohesion>\n{"score":7,"drivers":"topic convergence","shifts":"user clarified goal"}\n</cohesion>`
    const { visible, cohesion } = parseCohesion(raw)
    expect(visible).toBe('Here is my response.')
    expect(cohesion?.score).toBe(7)
    expect(cohesion?.drivers).toBe('topic convergence')
    expect(cohesion?.shifts).toBe('user clarified goal')
  })

  it('returns fallback cohesion (score 5) when block is absent', () => {
    const { visible, cohesion } = parseCohesion('Just a response with no block.')
    expect(visible).toBe('Just a response with no block.')
    expect(cohesion.score).toBe(5)
    expect(cohesion.drivers).toContain('missing')
  })

  it('returns fallback cohesion on malformed JSON inside block', () => {
    const raw = `Response.\n<cohesion>\nnot valid json\n</cohesion>`
    const { visible, cohesion } = parseCohesion(raw)
    expect(visible).toBe('Response.')
    expect(cohesion.score).toBe(5)
  })

  it('clamps non-numeric score to 5', () => {
    const raw = `Response.\n<cohesion>\n{"score":"high","drivers":"x","shifts":"y"}\n</cohesion>`
    const { cohesion } = parseCohesion(raw)
    expect(cohesion?.score).toBe(5)
  })

  it('handles multiline response with cohesion block in the middle', () => {
    const raw = `Line one.\n<cohesion>\n{"score":9,"drivers":"deep integration","shifts":"new insight"}\n</cohesion>\nLine two.`
    const { visible } = parseCohesion(raw)
    expect(visible).not.toContain('<cohesion>')
    expect(visible).toContain('Line one.')
    expect(visible).toContain('Line two.')
  })
})

describe('formatCohesionBanner', () => {
  it('renders filled and empty blocks for a given score', () => {
    const banner = formatCohesionBanner({ score: 3, drivers: 'drifting', shifts: '' })
    expect(banner).toContain('3/10')
    expect(banner).toContain('███')
    expect(banner).toContain('░░░░░░░')
    expect(banner).toContain('drifting')
  })

  it('returns parse-failed message when cohesion is undefined', () => {
    expect(formatCohesionBanner(undefined)).toBe('[Cohesion: parse failed]')
  })

  it('renders full bar for score 10', () => {
    const banner = formatCohesionBanner({ score: 10, drivers: 'perfect', shifts: '' })
    expect(banner).toContain('█'.repeat(10))
    expect(banner).not.toContain('░')
  })
})
