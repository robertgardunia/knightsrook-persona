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

export type McpToolCall = {
  name: string
  input: Record<string, unknown>
  result?: unknown
}

export type Turn = {
  id: string
  role: Role
  source: 'human' | 'internal' | 'self'
  content: string
  rawLLMContent?: string
  rawContent?: unknown[]  // full content block array when MCP tool use occurred
  cohesion?: CohesionRating
  importance?: ImportanceTags
  normalizationApplied?: NormalizationActions
  retrieval?: { cohesionCount: number; cohesionSims: number[]; factualCount: number }
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
  confidence: number
  source: 'conversation' | 'internal'
  createdAt: number
}

// Telemetry — full request lifecycle trace, one per turn
export type RetrievalTelemetry = {
  cohesion: { count: number; similarities: number[] }
  factual:  { count: number; keywordHits: number[] }
  traversal?: { entryPoints: number; traversalNodes: number; totalInjected: number; maxDepth: number }
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

export type InjectedMemory = {
  cluster: string
  summary: string
  similarity?: number
  source: 'cohesion' | 'factual'
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
  injectedMemories: InjectedMemory[]
  recalledClusters: string[]
  pushbacks: PushbackEvent[]
  mcpToolCalls: McpToolCall[]
  mindState: MindSnapshot
}

export type PushbackEvent = {
  type: 'recall_gate' | 'cohesion_reprompt'
  reason: string
}

// ── Mind State ────────────────────────────────────────────────────────────────

export type MindStateLabel = 'dream' | 'conversation' | 'goblin' | 'refractory'

export type Goblin = {
  id: string
  trigger: string           // description of the broken edge
  firedAt: number
  resolvedAt?: number
  fadedAt?: number
  status: 'active' | 'resolved' | 'faded'
}

export type StateEvent =
  | { type: 'state_transition';   from: MindStateLabel; to: MindStateLabel; reason: string; timestamp: number }
  | { type: 'cohesion_drop';      previous: number; current: number; delta: number; externalStimulus: boolean; timestamp: number }
  | { type: 'goblin_fired';       goblinId: string; trigger: string; timestamp: number }
  | { type: 'goblin_queued';      trigger: string; queueDepth: number; timestamp: number }
  | { type: 'goblin_resolved';    goblinId: string; timestamp: number }
  | { type: 'goblin_faded';       goblinId: string; timestamp: number }
  | { type: 'budget_tick';        used: number; remaining: number; timestamp: number }
  | { type: 'budget_exhausted';   timestamp: number }
  | { type: 'budget_reset';       timestamp: number }
  | { type: 'session_interrupted'; cohesionAt: number | null; timestamp: number }

export type MindSnapshot = {
  state: MindStateLabel
  equilibrium: number          // 0–10, derived from cohesion trajectory + goblin load
  cohesionTrajectory: number[] // last N scores, oldest first
  activeGoblins: Goblin[]
  ideaBudget: { used: number; limit: number; remaining: number }
  recentEvents: StateEvent[]   // last 20 events for the graph
}
