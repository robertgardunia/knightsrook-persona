import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../prompts.js'

describe('buildSystemPrompt', () => {
  it('always includes the cohesion requirement block', () => {
    const prompt = buildSystemPrompt('', '', { catches: 0, cycles: 0 })
    expect(prompt).toContain('<cohesion>')
    expect(prompt).toContain('NON-NEGOTIABLE')
  })

  it('includes cohesion context when provided', () => {
    const prompt = buildSystemPrompt('topic convergence from prior session', '', { catches: 0, cycles: 0 })
    expect(prompt).toContain('topic convergence from prior session')
    expect(prompt).toContain('What you remember')
  })

  it('omits cohesion context section when empty', () => {
    const prompt = buildSystemPrompt('', '', { catches: 0, cycles: 0 })
    // 'What you remember' header only appears in the dynamic memory injection, not the static requirement block
    const parts = prompt.split('[SUBSTRATE INJECTION]')
    expect(parts[1] ?? '').not.toContain('What you remember — speak from this')
  })

  it('includes factual context when provided', () => {
    const prompt = buildSystemPrompt('', 'prefers TypeScript', { catches: 0, cycles: 0 })
    expect(prompt).toContain('prefers TypeScript')
    expect(prompt).toContain('Specific things you know')
  })

  it('omits factual context section when empty', () => {
    const prompt = buildSystemPrompt('', '', { catches: 0, cycles: 0 })
    expect(prompt).not.toContain('Specific things you know')
  })

  it('includes normalization stats when cycles > 0', () => {
    const prompt = buildSystemPrompt('', '', { catches: 3, cycles: 2 })
    expect(prompt).toContain('2 consolidation cycle')
    expect(prompt).toContain('3 normalization intervention')
  })

  it('omits normalization stats when cycles === 0', () => {
    const prompt = buildSystemPrompt('', '', { catches: 0, cycles: 0 })
    expect(prompt).not.toContain('consolidation cycle')
  })

  it('always ends with continuity instruction', () => {
    const prompt = buildSystemPrompt('', '', { catches: 0, cycles: 0 })
    expect(prompt).toContain('Maintain continuity')
  })
})
