import type { ImportanceTags } from './types.js'

const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+)*\b/g
const FACT_RE = /\b\w[\w\s]{2,20}\s+(?:is|are|was|were|has|have|had)\s+[\w\s]{2,40}/gi
const PREF_RE = /\b(?:I prefer|I like|I don't|I dislike|always|never|usually|typically)\b[^.!?]*/gi
const DECISION_RE = /\b(?:we decided|let's|I'll|we agreed|we're going to|we will|going with)\b[^.!?]*/gi

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map(s => s.trim()).filter(s => s.length > 2 && s.length < 120))]
}

export function extractImportance(content: string): ImportanceTags {
  return {
    entities: dedupe(content.match(PROPER_NOUN_RE) ?? []),
    facts: dedupe((content.match(FACT_RE) ?? []).map(s => s.slice(0, 100))),
    preferences: dedupe((content.match(PREF_RE) ?? []).map(s => s.slice(0, 100))),
    decisions: dedupe((content.match(DECISION_RE) ?? []).map(s => s.slice(0, 100))),
  }
}

export function formatImportanceBanner(tags: ImportanceTags): string {
  const parts = [
    `${tags.entities.length} entities`,
    `${tags.facts.length} facts`,
    `${tags.preferences.length} prefs`,
    `${tags.decisions.length} decisions`,
  ]
  return `[Indexed: ${parts.join(', ')}]`
}

export function mergeImportance(tags: ImportanceTags[]): ImportanceTags {
  return {
    entities: dedupe(tags.flatMap(t => t.entities)),
    facts: dedupe(tags.flatMap(t => t.facts)),
    preferences: dedupe(tags.flatMap(t => t.preferences)),
    decisions: dedupe(tags.flatMap(t => t.decisions)),
  }
}
