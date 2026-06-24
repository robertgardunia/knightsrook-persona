import { describe, it, expect } from 'vitest'
import { normalize } from '../normalizer.js'
import type { ConsolidatedMemory } from '../types.js'

function makeMemory(overrides: Partial<ConsolidatedMemory> = {}): ConsolidatedMemory {
  return {
    id: 'test-id',
    cluster: 'test',
    turnIds: [],
    summary: 'The project uses Postgres for storage.',
    cohesionPeak: 7,
    mergedEntities: [],
    mergedFacts: ['The project uses Postgres for storage.'],
    mergedPreferences: [],
    mergedDecisions: [],
    tier: 'warm',
    lastRetrieved: 0,
    retrievalCount: 0,
    confidence: 0.0,
    source: 'conversation' as const,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('normalize', () => {
  it('passes through candidate unchanged when no memories', () => {
    const { normalized, actions } = normalize('Hello there.', 'hi', [], [])
    expect(normalized).toBe('Hello there.')
    expect(actions.contradictionsFound).toEqual([])
    expect(actions.additionsIntegrated).toEqual([])
  })

  it('flags contradiction when candidate negates a cohesion memory with high token overlap', () => {
    const mem = makeMemory({
      summary: 'The system uses Postgres database storage backend for storing data.',
    })
    // High overlap + negation in candidate
    const candidate = "The system doesn't use Postgres database storage backend at all."
    const { actions } = normalize(candidate, 'what database?', [mem], [])
    expect(actions.contradictionsFound).toContain('test-id')
  })

  it('does not flag contradiction when negation is absent on both sides', () => {
    const mem = makeMemory({ summary: 'The project uses Postgres for storage.' })
    const { actions } = normalize('The project uses Postgres for storage.', 'database?', [mem], [])
    expect(actions.contradictionsFound).toEqual([])
  })

  it('does not flag contradiction when token overlap is low', () => {
    const mem = makeMemory({ summary: 'The project uses Postgres for storage.' })
    const candidate = "I like cats and dogs very much."
    const { actions } = normalize(candidate, 'pets?', [mem], [])
    expect(actions.contradictionsFound).toEqual([])
  })

  it('flags missed factual relevance when user asked about known topic but response missed it', () => {
    const mem = makeMemory({
      summary: 'Postgres database storage system architecture backend.',
      mergedFacts: ['The project uses Postgres.'],
    })
    // User asks about postgres/database — high query overlap; response doesn't mention it
    const { actions } = normalize(
      'I am not sure about that.',
      'What postgres database storage system are you using?',
      [],
      [mem]
    )
    expect(actions.additionsIntegrated).toContain('test-id')
  })

  it('does not flag missed relevance when response already covers the topic', () => {
    const mem = makeMemory({
      summary: 'Postgres database storage system.',
      mergedFacts: ['The project uses Postgres.'],
    })
    const { actions } = normalize(
      'We use a Postgres database storage system for the project backend.',
      'What postgres database storage system?',
      [],
      [mem]
    )
    expect(actions.additionsIntegrated).toEqual([])
  })
})
