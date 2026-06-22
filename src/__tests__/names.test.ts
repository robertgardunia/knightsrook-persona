import { describe, it, expect } from 'vitest'
import { generatePersonaName } from '../names.js'

describe('generatePersonaName', () => {
  it('returns a string matching adjective-noun format', () => {
    const name = generatePersonaName()
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it('produces unique names across multiple calls', () => {
    const names = new Set(Array.from({ length: 20 }, () => generatePersonaName()))
    // With 100+ adjectives and nouns, 20 calls hitting the same pair would be extraordinary
    expect(names.size).toBeGreaterThan(1)
  })

  it('contains exactly one hyphen', () => {
    for (let i = 0; i < 10; i++) {
      const name = generatePersonaName()
      expect(name.split('-')).toHaveLength(2)
    }
  })
})
