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
