import { describe, it, expect } from 'vitest'
import { extractImportance, mergeImportance, formatImportanceBanner } from '../importance.js'

describe('extractImportance', () => {
  it('extracts proper noun entities', () => {
    const { entities } = extractImportance('Robert is working on KnightsRook.')
    expect(entities).toContain('Robert')
    expect(entities).toContain('KnightsRook')
  })

  it('extracts preference statements', () => {
    const { preferences } = extractImportance('I prefer dark mode interfaces always.')
    expect(preferences.length).toBeGreaterThan(0)
    expect(preferences[0]).toMatch(/prefer/i)
  })

  it('extracts decision statements', () => {
    const { decisions } = extractImportance("We decided to use Postgres for storage.")
    expect(decisions.length).toBeGreaterThan(0)
  })

  it('extracts fact statements', () => {
    const { facts } = extractImportance('The project is a memory substrate.')
    expect(facts.length).toBeGreaterThan(0)
  })

  it('returns empty arrays for content with no matches', () => {
    const tags = extractImportance('ok cool yes')
    expect(tags.entities).toEqual([])
    expect(tags.preferences).toEqual([])
    expect(tags.decisions).toEqual([])
  })

  it('deduplicates repeated terms', () => {
    const { entities } = extractImportance('Robert and Robert and Robert')
    expect(entities.filter(e => e === 'Robert').length).toBe(1)
  })
})

describe('mergeImportance', () => {
  it('merges and deduplicates across multiple tag sets', () => {
    const a = { entities: ['Alice', 'Bob'], facts: ['x is y'], preferences: [], decisions: [] }
    const b = { entities: ['Bob', 'Carol'], facts: ['x is y'], preferences: [], decisions: [] }
    const merged = mergeImportance([a, b])
    expect(merged.entities).toContain('Alice')
    expect(merged.entities).toContain('Bob')
    expect(merged.entities).toContain('Carol')
    expect(merged.entities.filter(e => e === 'Bob').length).toBe(1)
    expect(merged.facts.filter(f => f === 'x is y').length).toBe(1)
  })

  it('handles empty input', () => {
    const merged = mergeImportance([])
    expect(merged.entities).toEqual([])
    expect(merged.facts).toEqual([])
  })
})

describe('formatImportanceBanner', () => {
  it('formats counts correctly', () => {
    const tags = { entities: ['A', 'B'], facts: ['f1'], preferences: [], decisions: ['d1', 'd2'] }
    const banner = formatImportanceBanner(tags)
    expect(banner).toContain('2 entities')
    expect(banner).toContain('1 facts')
    expect(banner).toContain('0 prefs')
    expect(banner).toContain('2 decisions')
  })
})
