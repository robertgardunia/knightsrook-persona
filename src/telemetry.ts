import type { TurnTelemetry } from './types.js'

const BAR_WIDTH = 10

function bar(value: number, max: number, width = BAR_WIDTH): string {
  const filled = Math.round((value / max) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function pct(value: number, max: number): string {
  return ((value / max) * 100).toFixed(1) + '%'
}

function fmt(n: number): string {
  return n.toLocaleString()
}

export function renderTelemetry(t: TurnTelemetry): string {
  const lines: string[] = []
  const divider = '─'.repeat(56)

  lines.push(`\n${divider}`)
  lines.push(` TURN ${t.turnNumber}  ·  persona: ${t.personaId}`)
  lines.push(divider)

  // Cohesion
  if (t.cohesion) {
    const b = bar(t.cohesion.score, 10)
    const tag = t.cohesionHealth.recovered ? '  (recovered via re-prompt)' : ''
    lines.push(` COHESION    ${b}  ${t.cohesion.score}/10${tag}`)
    lines.push(`   drivers : ${t.cohesion.drivers || '—'}`)
    lines.push(`   shifts  : ${t.cohesion.shifts || '—'}`)
  } else {
    lines.push(` COHESION    ⚠ NO RATING — ran as a plain LLM this turn (no weighted edge added)`)
  }
  const h = t.cohesionHealth
  lines.push(`   coverage: ${(h.coveragePct * 100).toFixed(0)}%  (${h.ratedTurns} rated / ${h.unratedTurns} unrated)`)

  lines.push('')

  // Context
  const ctxBar = bar(t.contextTokens, t.contextBudget)
  const ctxPct = pct(t.contextTokens, t.contextBudget)
  lines.push(` CONTEXT     ${ctxBar}  ${fmt(t.contextTokens)} / ${fmt(t.contextBudget)} (${ctxPct})`)
  lines.push(`   consolidation triggers at 25% = ${fmt(Math.round(t.contextBudget * 0.25))} tokens`)

  lines.push('')

  // Retrieval
  lines.push(` RETRIEVAL`)
  if (t.retrieval.cohesion.count === 0) {
    lines.push(`   cohesion  0 memories  (no consolidated memories yet)`)
  } else {
    const sims = t.retrieval.cohesion.similarities.map(s => s.toFixed(3)).join(', ')
    lines.push(`   cohesion  ${t.retrieval.cohesion.count} memories  similarities: ${sims}`)
  }
  if (t.retrieval.factual.count === 0) {
    lines.push(`   factual   0 memories  (no keyword matches)`)
  } else {
    const hits = t.retrieval.factual.keywordHits.join(', ')
    lines.push(`   factual   ${t.retrieval.factual.count} memories  keyword hits: ${hits}`)
  }

  lines.push('')

  // Normalization
  lines.push(` NORMALIZATION`)
  lines.push(`   contradictions  ${t.normalization.contradictions}`)
  lines.push(`   additions       ${t.normalization.additions}`)
  if (t.normalization.candidateLength !== t.normalization.normalizedLength) {
    const delta = t.normalization.normalizedLength - t.normalization.candidateLength
    lines.push(`   response length  ${fmt(t.normalization.candidateLength)} → ${fmt(t.normalization.normalizedLength)} chars (${delta > 0 ? '+' : ''}${delta})`)
  }

  lines.push('')

  // Storage
  lines.push(` STORAGE`)
  lines.push(`   user turn   ${t.storage.userTurnId}`)
  lines.push(`   asst turn   ${t.storage.assistantTurnId}`)
  lines.push(`   archive     ${t.storage.archivePath}`)

  // Consolidation
  if (t.consolidation.triggered) {
    lines.push('')
    lines.push(` ⚡ CONSOLIDATION  (buffer ${fmt(t.consolidation.bufferTokensBefore)} tokens > threshold)`)
    lines.push(`   preserved   ${t.consolidation.preserved} turns`)
    if (t.consolidation.summarized.length > 0) {
      lines.push(`   summarized  ${t.consolidation.summarized.length} clusters`)
      for (const c of t.consolidation.summarized) {
        lines.push(`     "${c.cluster}"  ${c.turnCount} turns  peak cohesion: ${c.cohesionPeak}  → ${c.tier}`)
      }
    }
    lines.push(`   dropped     ${t.consolidation.dropped} turns`)
    lines.push(`   buffer now  ${fmt(t.consolidation.bufferTokensAfter)} tokens`)
  }

  lines.push(divider)

  return lines.join('\n')
}
