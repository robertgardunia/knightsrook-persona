import Anthropic from '@anthropic-ai/sdk'
import { ulid } from 'ulid'
import type { Turn, TurnTelemetry, ConsolidationTelemetry } from './types.js'
import { Storage } from './storage.js'
import { parseCohesion } from './cohesion.js'
import { extractImportance, formatImportanceBanner } from './importance.js'
import { normalize } from './normalizer.js'
import { consolidate } from './consolidator.js'
import { buildSystemPrompt } from './prompts.js'
import { embedText } from './embeddings.js'

const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-opus-4-8':             200_000,
  'claude-sonnet-4-6':           200_000,
  'claude-haiku-4-5-20251001':   200_000,
}

function getContextLimit(model: string): number {
  return MODEL_CONTEXT_TOKENS[model] ?? 100_000
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export type SubstrateResponse = {
  visible: string
  importanceBanner: string
  telemetry: TurnTelemetry
}

// @pattern:anthropic-sdk-node
export class Substrate {
  private client: Anthropic
  private model: string
  private budgetPct: number
  private personaId: string
  private buffer: Turn[] = []
  private storage: Storage
  private turnNumber = 0

  constructor(apiKey: string, model: string, budgetPct: number, personaId: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.budgetPct = budgetPct
    this.personaId = personaId
    this.storage = new Storage(personaId)
  }

  async init() {
    await this.storage.ensureReady()
  }

  private bufferTokens(): number {
    return this.buffer.reduce((sum, t) => sum + t.tokens, 0)
  }

  private shouldConsolidate(): boolean {
    const limit = getContextLimit(this.model)
    return this.bufferTokens() > limit * this.budgetPct
  }

  async respond(userMessage: string): Promise<SubstrateResponse> {
    this.turnNumber++
    const contextBudget = getContextLimit(this.model)

    // User turn
    const userTurn: Turn = {
      id: ulid(),
      role: 'user',
      content: userMessage,
      importance: extractImportance(userMessage),
      tokens: estimateTokens(userMessage),
      timestamp: Date.now(),
    }
    this.buffer.push(userTurn)
    await this.storage.saveTurn(userTurn)

    // Embed + retrieve in parallel
    const [queryEmbedding, factualMems] = await Promise.all([
      embedText(userMessage),
      this.storage.retrieveByImportance(userMessage),
    ])
    const cohesionMems = await this.storage.retrieveCohesionWeighted(queryEmbedding)

    const cohesionContext = cohesionMems.map(m => `[${m.cluster}] ${m.summary}`).join('\n')
    const factualContext = [
      ...new Set([
        ...factualMems.flatMap(m => m.mergedFacts.slice(0, 2)),
        ...factualMems.flatMap(m => m.mergedPreferences.slice(0, 2)),
        ...factualMems.flatMap(m => m.mergedDecisions.slice(0, 2)),
      ])
    ].slice(0, 10).join('\n')

    const systemPrompt = buildSystemPrompt(cohesionContext, factualContext, {
      catches: 0,
      cycles: 0,
    })

    // Call LLM
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: this.buffer.map(t => ({ role: t.role, content: t.content })),
    })

    const rawText = response.content[0].type === 'text' ? response.content[0].text : ''
    const { visible: candidate, cohesion } = parseCohesion(rawText)

    // Normalize
    const { normalized, actions } = normalize(candidate, userMessage, cohesionMems, factualMems)

    const importanceTags = extractImportance(normalized)

    // Assistant turn
    const assistantTurn: Turn = {
      id: ulid(),
      role: 'assistant',
      content: normalized,
      rawLLMContent: candidate,
      cohesion,
      importance: importanceTags,
      normalizationApplied: actions,
      tokens: estimateTokens(normalized),
      timestamp: Date.now(),
    }
    this.buffer.push(assistantTurn)
    await this.storage.saveTurn(assistantTurn)

    const tokensBeforeConsolidation = this.bufferTokens()

    // Consolidate if needed
    let consolidationTelemetry: ConsolidationTelemetry = {
      triggered: false,
      bufferTokensBefore: tokensBeforeConsolidation,
      bufferTokensAfter: tokensBeforeConsolidation,
      preserved: 0,
      summarized: [],
      dropped: 0,
    }

    if (this.shouldConsolidate()) {
      const result = await consolidate(this.client, this.model, this.buffer, this.storage)
      this.buffer = result.buffer
      consolidationTelemetry = result.telemetry
    }

    const telemetry: TurnTelemetry = {
      turnNumber: this.turnNumber,
      personaId: this.personaId,
      cohesion,
      contextTokens: this.bufferTokens(),
      contextBudget,
      contextPct: this.bufferTokens() / contextBudget,
      retrieval: {
        cohesion: {
          count: cohesionMems.length,
          similarities: cohesionMems.map(m => m.similarity ?? 0),
        },
        factual: {
          count: factualMems.length,
          keywordHits: factualMems.map(m => m.keywordHits ?? 0),
        },
      },
      normalization: {
        contradictions: actions.contradictionsFound.length,
        additions: actions.additionsIntegrated.length,
        candidateLength: candidate.length,
        normalizedLength: normalized.length,
      },
      storage: {
        userTurnId: userTurn.id,
        assistantTurnId: assistantTurn.id,
        personaId: this.personaId,
        archivePath: `data/archive/${this.personaId}/`,
      },
      consolidation: consolidationTelemetry,
    }

    return {
      visible: normalized,
      importanceBanner: formatImportanceBanner(importanceTags),
      telemetry,
    }
  }
}
