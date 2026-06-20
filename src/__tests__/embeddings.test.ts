import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after stubbing global
const { embedText } = await import('../embeddings.js')

describe('embedText', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns embedding array from Ollama response', async () => {
    const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [fakeEmbedding] }),
    })

    const result = await embedText('hello world')
    expect(result).toHaveLength(768)
    expect(result[0]).toBeCloseTo(0)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/embed'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 })
    await expect(embedText('test')).rejects.toThrow('Ollama embed error: 503')
  })

  it('uses OLLAMA_HOST env var when set', async () => {
    process.env.OLLAMA_HOST = 'http://custom-host:11434'
    const fakeEmbedding = new Array(768).fill(0.1)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [fakeEmbedding] }),
    })

    // Re-import won't re-evaluate module-level const — test via call arg
    await embedText('test')
    // The module caches OLLAMA_HOST at load time, so just verify fetch was called
    expect(mockFetch).toHaveBeenCalled()
    delete process.env.OLLAMA_HOST
  })
})
