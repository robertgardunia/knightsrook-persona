import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Turn } from '../types.js'

// Mock embeddings before importing consolidator
vi.mock('../embeddings.js', () => ({
  embedText: vi.fn().mockResolvedValue(new Array(768).fill(0)),
}))

const { captureTurn } = await import('../consolidator.js')

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-' + Math.random().toString(36).slice(2),
    role: 'user',
    source: 'human',
    content: 'test message',
    tokens: 10,
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeStorage() {
  return { saveMemory: vi.fn().mockResolvedValue(undefined) } as any
}

describe('captureTurn', () => {
  let storage: ReturnType<typeof makeStorage>

  beforeEach(() => {
    storage = makeStorage()
  })

  it('returns null when assistant turn has no cohesion rating', async () => {
    const user = makeTurn({ role: 'user', source: 'human' })
    const assistant = makeTurn({ role: 'assistant', source: 'self' })
    const result = await captureTurn(user, assistant, storage)
    expect(result).toBeNull()
    expect(storage.saveMemory).not.toHaveBeenCalled()
  })

  it('stores a warm memory for high cohesion (score >= 7)', async () => {
    const user = makeTurn({ role: 'user', source: 'human' })
    const assistant = makeTurn({
      role: 'assistant',
      source: 'self',
      cohesion: { score: 8, drivers: 'deep integration', shifts: 'user aligned' },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result).not.toBeNull()
    expect(result!.memory.tier).toBe('warm')
    expect(result!.memory.cohesionPeak).toBe(8)
    expect(storage.saveMemory).toHaveBeenCalledOnce()
  })

  it('stores a cold memory for low cohesion (score < 7)', async () => {
    const user = makeTurn({ role: 'user', source: 'human' })
    const assistant = makeTurn({
      role: 'assistant',
      source: 'self',
      cohesion: { score: 4, drivers: 'drifting topic', shifts: 'no resolution' },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result!.memory.tier).toBe('cold')
  })

  it('builds summary from drivers + shifts', async () => {
    const user = makeTurn({ role: 'user', source: 'human' })
    const assistant = makeTurn({
      role: 'assistant',
      source: 'self',
      cohesion: { score: 7, drivers: 'goal clarified', shifts: 'scope narrowed' },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result!.memory.summary).toBe('goal clarified — shift: scope narrowed')
  })

  it('uses only drivers when shifts is empty', async () => {
    const user = makeTurn({ role: 'user', source: 'human' })
    const assistant = makeTurn({
      role: 'assistant',
      source: 'self',
      cohesion: { score: 6, drivers: 'steady exchange', shifts: '' },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result!.memory.summary).toBe('steady exchange')
  })

  it('cluster label is derived from drivers (truncated at 60 chars)', async () => {
    const longDrivers = 'a'.repeat(100)
    const user = makeTurn({ role: 'user', source: 'human' })
    const assistant = makeTurn({
      role: 'assistant',
      source: 'self',
      cohesion: { score: 7, drivers: longDrivers, shifts: '' },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result!.cluster.cluster.length).toBeLessThanOrEqual(60)
  })

  it('merges importance tags from both turns', async () => {
    const user = makeTurn({
      role: 'user',
      source: 'human',
      importance: { entities: ['Alice'], facts: [], preferences: [], decisions: [] },
    })
    const assistant = makeTurn({
      role: 'assistant',
      source: 'self',
      cohesion: { score: 8, drivers: 'named entity', shifts: '' },
      importance: { entities: ['Bob'], facts: ['x is y'], preferences: [], decisions: [] },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result!.memory.mergedEntities).toContain('Alice')
    expect(result!.memory.mergedEntities).toContain('Bob')
    expect(result!.memory.mergedFacts).toContain('x is y')
  })

  it('includes both turn IDs in the memory', async () => {
    const user = makeTurn({ id: 'user-id-1', role: 'user', source: 'human' })
    const assistant = makeTurn({
      id: 'asst-id-1',
      role: 'assistant',
      source: 'self',
      cohesion: { score: 7, drivers: 'convergence', shifts: '' },
    })
    const result = await captureTurn(user, assistant, storage)
    expect(result!.memory.turnIds).toContain('user-id-1')
    expect(result!.memory.turnIds).toContain('asst-id-1')
  })
})
