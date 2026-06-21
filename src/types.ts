export type Role = 'user' | 'assistant'

export type CohesionRating = {
  score: number
  drivers: string
  shifts: string
}

export type ImportanceTags = {
  entities: string[]
  facts: string[]
  preferences: string[]
  decisions: string[]
}

export type NormalizationActions = {
  contradictionsFound: string[]
  additionsIntegrated: string[]
}

export type Turn = {
  id: string
  role: Role
  content: string
  rawLLMContent?: string
  cohesion?: CohesionRating
  importance?: ImportanceTags
  normalizationApplied?: NormalizationActions
  tokens: number
  timestamp: number
}

export type ConsolidatedMemory = {
  id: string
  cluster: string
  turnIds: string[]
  summary: string
  cohesionPeak: number
  mergedEntities: string[]
  mergedFacts: string[]
  mergedPreferences: string[]
  mergedDecisions: string[]
  tier: 'hot' | 'warm' | 'cold' | 'archive'
  lastRetrieved: number
  retrievalCount: number
  createdAt: number
}

// Telemetry — full request lifecycle trace, one per turn
export type RetrievalTelemetry = {
  cohesion: { count: number; similarities: number[] }
  factual:  { count: number; keywordHits: number[] }
}

export type NormalizationTelemetry = {
  contradictions: number
  additions: number
  candidateLength: number  // chars before normalization
  normalizedLength: number // chars after (same if no changes)
}

export type StorageTelemetry = {
  userTurnId: string
  assistantTurnId: string
  personaId: string
  archivePath: string
}

export type ConsolidationCluster = {
  cluster: string
  turnCount: number
  cohesionPeak: number
  tier: string
}

export type ConsolidationTelemetry = {
  triggered: boolean
  bufferTokensBefore: number
  bufferTokensAfter: number
  preserved: number
  summarized: ConsolidationCluster[]
  dropped: number
}

// Cohesion is THE differentiator — the weighted edges that make this more than
// a plain LLM. A turn with no rating contributed nothing to those edges, so we
// track coverage explicitly: a falling rate means the system is silently
// regressing toward a stock model.
export type CohesionHealth = {
  rated: boolean        // did this turn end with a usable cohesion rating?
  recovered: boolean    // was it only obtained after the re-prompt push-back?
  ratedTurns: number    // lifetime rated turns for this persona
  unratedTurns: number  // lifetime turns that degraded to no rating
  coveragePct: number   // ratedTurns / (ratedTurns + unratedTurns)
}

export type TurnTelemetry = {
  turnNumber: number
  personaId: string
  cohesion: CohesionRating | undefined
  cohesionHealth: CohesionHealth
  contextTokens: number
  contextBudget: number
  contextPct: number
  retrieval: RetrievalTelemetry
  normalization: NormalizationTelemetry
  storage: StorageTelemetry
  consolidation: ConsolidationTelemetry
}
