import Anthropic from '@anthropic-ai/sdk'
import { ulid } from 'ulid'
import type { Turn, TurnTelemetry, ConsolidationTelemetry, InjectedMemory, McpToolCall } from './types.js'
import { Storage } from './storage.js'
import { parseCohesion, parseRecall, validateRecall } from './cohesion.js'
import { extractImportance, formatImportanceBanner } from './importance.js'
import { normalize } from './normalizer.js'
import { captureTurn } from './consolidator.js'
import { buildSystemPrompt } from './prompts.js'
import { embedText } from './embeddings.js'
import { MindState } from './mind-state.js'

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

export type SubstrateEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: unknown }

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
  // Cohesion coverage — the differentiator's health. See CohesionHealth.
  private ratedTurns = 0
  private unratedTurns = 0
  // Turn IDs already captured into Postgres. The eviction invariant: a turn may
  // only be dropped from the hot buffer once it is in this set — so the cliff's
  // edge is lossless, everything is already weighted and retrievable.
  private captured = new Set<string>()
  private mind = new MindState()
  onMindEvent?: (event: import('./types.js').StateEvent) => void

  constructor(apiKey: string, model: string, budgetPct: number, personaId: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.budgetPct = budgetPct
    this.personaId = personaId
    this.storage = new Storage(personaId)
  }

  async init() {
    await this.storage.ensureReady()
    // Seed coverage counters from persisted turns so the differentiator's health
    // reflects this persona's entire lifetime, not just the current process.
    const coverage = await this.storage.cohesionCoverage()
    this.ratedTurns = coverage.rated
    this.unratedTurns = coverage.unrated
    // Pipe mind state events out so server can broadcast them live
    this.mind.onEvent = (event) => this.onMindEvent?.(event)
  }

  private bufferTokens(): number {
    return this.buffer.reduce((sum, t) => sum + t.tokens, 0)
  }

  private bufferBudget(): number {
    return getContextLimit(this.model) * this.budgetPct
  }

  // Lossless FIFO eviction. Capture already ran on every completed exchange, so
  // anything old enough to evict is already in Postgres. Drop oldest captured
  // turns until back under budget; never drop an uncaptured turn. No model call.
  private evictToBudget(): number {
    const budget = this.bufferBudget()
    let dropped = 0
    while (this.bufferTokens() > budget && this.buffer.length > 0 && this.captured.has(this.buffer[0].id)) {
      this.buffer.shift()
      dropped++
    }
    return dropped
  }

  sessionInterrupted(): void {
    const lastScore = this.mind.snapshot().cohesionTrajectory.at(-1) ?? null
    this.mind.sessionInterrupted(lastScore)
  }

  mindSnapshot() {
    return this.mind.snapshot()
  }

  // Dream loop interface — called by Dreamer, not by conversation turns
  tickDreamBudget(tokens: number): void { this.mind.tickBudget(tokens) }
  recordDreamCohesion(score: number): void { this.mind.recordCohesion(score, false) }
  resolveGoblin(id: string): void { this.mind.resolveGoblin(id) }
  fadeGoblin(id: string): void { this.mind.fadeGoblin(id) }
  getStorage(): Storage { return this.storage }

  async respond(userMessage: string, onEvent?: (e: SubstrateEvent) => void): Promise<SubstrateResponse> {
    this.turnNumber++
    const contextBudget = getContextLimit(this.model)

    this.mind.onConversationStart()

    // User turn
    const userTurn: Turn = {
      id: ulid(),
      role: 'user',
      source: 'human',
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

    const injectedMemories: InjectedMemory[] = [
      ...cohesionMems.map(m => ({ cluster: m.cluster, summary: m.summary, similarity: m.similarity, source: 'cohesion' as const })),
      ...factualMems.map(m => ({ cluster: m.cluster, summary: m.summary, source: 'factual' as const })),
    ]

    if (injectedMemories.length > 0) {
      console.log(`\n[INJECTED MEMORIES — turn ${this.turnNumber}]`)
      for (const m of injectedMemories) {
        const sim = m.similarity != null ? ` sim=${m.similarity.toFixed(3)}` : ''
        console.log(`  [${m.source}${sim}] [${m.cluster}] ${m.summary.slice(0, 120)}`)
      }
    } else {
      console.log(`\n[INJECTED MEMORIES — turn ${this.turnNumber}] none — running cold LLM`)
    }

    const systemPrompt = buildSystemPrompt(cohesionContext, factualContext, {
      catches: 0,
      cycles: 0,
    })

    // Stream LLM via MCP beta — iterate raw chunks so we see mcp_tool_use/mcp_tool_result
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: this.buffer.map(t => ({
        role: t.role,
        content: (t.rawContent ?? t.content) as any,
      })),
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'knightsrook' }] as any,
      mcp_servers: [
        { type: 'url', url: 'https://mcp.knightsrook.com/mcp', name: 'knightsrook' },
      ],
    } as any, { headers: { 'anthropic-beta': 'mcp-client-2025-11-20' } })

    // Iterate raw SSE chunks — mcp_tool_use/mcp_tool_result only surface here.
    // Accumulate content blocks as we go so we don't exhaust the iterator before finalMessage().
    const pendingToolNames = new Map<number, string>()
    const contentBlocks: any[] = []
    let currentBlockIndex = -1

    for await (const chunk of stream as any) {
      if (chunk.type === 'content_block_start') {
        const block = { ...chunk.content_block }
        contentBlocks[chunk.index] = block
        currentBlockIndex = chunk.index

        if (block.type === 'mcp_tool_use') {
          pendingToolNames.set(chunk.index, block.name)
          onEvent?.({ type: 'tool_use', name: block.name, input: {} })
        }
        if (block.type === 'mcp_tool_result') {
          const name = pendingToolNames.get(chunk.index - 1) ?? ''
          const result = Array.isArray(block.content)
            ? block.content.map((c: any) => c.text ?? '').join('')
            : block.content ?? ''
          onEvent?.({ type: 'tool_result', name, result })
        }
      }
      if (chunk.type === 'content_block_delta') {
        const block = contentBlocks[chunk.index]
        if (chunk.delta?.type === 'text_delta') {
          if (block) block.text = (block.text ?? '') + chunk.delta.text
          onEvent?.({ type: 'text_delta', text: chunk.delta.text })
        }
        if (chunk.delta?.type === 'input_json_delta' && block) {
          block._inputJson = (block._inputJson ?? '') + chunk.delta.partial_json
        }
      }
    }

    // Finalise input on tool blocks
    for (const block of contentBlocks) {
      if (block?._inputJson) {
        try { block.input = JSON.parse(block._inputJson) } catch {}
        delete block._inputJson
      }
    }

    const response = await stream.finalMessage()

    // Concatenate all text blocks — multiple text blocks appear when tool calls interleave
    const rawText = (response.content as any[])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('')
    let { visible: candidate, cohesion } = parseCohesion(rawText)
    let { recalled } = parseRecall(rawText)

    // Recall gate — adversarial citation check.
    // If she cited no injected memories, or cited clusters that don't match what
    // was actually injected, push back once listing exactly what was available.
    const injectedClusters = injectedMemories.map(m => m.cluster)
    let recallGateFailed = false
    if (injectedClusters.length > 0 && (recalled === null || !validateRecall(recalled, injectedClusters))) {
      const clusterList = injectedClusters.map(c => `  - ${c}`).join('\n')
      const recallRetry = await (this.client.beta.messages.create as any)({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          ...this.buffer.map(t => ({ role: t.role, content: (t.rawContent ?? t.content) as any })),
          { role: 'assistant', content: rawText },
          {
            role: 'user',
            content:
              'Your response did not draw from your injected memories (INTERNAL sources). ' +
              'The following clusters were available to you:\n' + clusterList + '\n\n' +
              'Rewrite your response drawing from these memories. ' +
              'Include a <recall> block citing which clusters you used.',
          },
        ],
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'knightsrook' }],
        mcp_servers: [{ type: 'url', url: 'https://mcp.knightsrook.com/mcp', name: 'knightsrook' }],
        betas: ['mcp-client-2025-11-20'],
      })
      const retryRaw = (recallRetry.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('')
      const retryRecall = parseRecall(retryRaw)
      const retryCohesion = parseCohesion(retryRaw)
      if (retryRecall.recalled && validateRecall(retryRecall.recalled, injectedClusters)) {
        candidate = retryCohesion.visible || retryRecall.visible
        cohesion = retryCohesion.cohesion ?? cohesion
        recalled = retryRecall.recalled
        console.log(`[recall gate] retry passed — cited: ${recalled.join(', ')}`)
      } else {
        recallGateFailed = true
        console.warn(`[recall gate] retry failed — firing goblin`)
        this.mind.fireGoblin('recall gate failed: response did not draw from injected memories after retry')
      }
    }

    // Extract MCP tool calls for telemetry + buffer replay
    const mcpToolCalls: McpToolCall[] = (response.content as any[])
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => {
        const result = (response.content as any[]).find(
          (r: any) => r.type === 'tool_result' && r.tool_use_id === b.id
        )
        return {
          name: b.name as string,
          input: b.input as Record<string, unknown>,
          result: result?.content,
        }
      })

    if (mcpToolCalls.length > 0) {
      console.log(`\n[MCP TOOL CALLS — turn ${this.turnNumber}]`)
      for (const c of mcpToolCalls) {
        console.log(`  ${c.name}(${JSON.stringify(c.input).slice(0, 120)})`)
      }
    }

    // Push back on a missing rating rather than fabricating one. The block is
    // non-negotiable (see prompts.ts); if the model omitted it, demand it once
    // more for this exact response. Only if it still refuses do we record an
    // honest absence (cohesion === null) — never a fake neutral score.
    let recovered = false
    if (cohesion === null) {
      const retry = await (this.client.beta.messages.create as any)({
        model: this.model,
        max_tokens: 256,
        system: systemPrompt,
        messages: [
          ...this.buffer.map(t => ({ role: t.role, content: (t.rawContent ?? t.content) as any })),
          { role: 'assistant', content: rawText },
          {
            role: 'user',
            content:
              'Your previous response omitted the required <cohesion> block. ' +
              'Reply with ONLY that block (the <cohesion>…</cohesion> JSON) rating that response. Nothing else.',
          },
        ],
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'knightsrook' }] as any,
        mcp_servers: [
          { type: 'url', url: 'https://mcp.knightsrook.com/mcp', name: 'knightsrook' },
        ] as any,
        betas: ['mcp-client-2025-11-20'] as any,
      })
      const retryText = (retry.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('')
      cohesion = parseCohesion(retryText).cohesion
      recovered = cohesion !== null
    }

    // Track coverage of the differentiator. An unrated turn contributed no
    // weighted edge — the system ran as a plain LLM for that exchange.
    if (cohesion === null) this.unratedTurns++
    else {
      this.ratedTurns++
      this.mind.recordCohesion(cohesion.score, true) // true = user-driven turn
    }
    const totalRated = this.ratedTurns + this.unratedTurns
    const cohesionHealth = {
      rated: cohesion !== null,
      recovered,
      ratedTurns: this.ratedTurns,
      unratedTurns: this.unratedTurns,
      coveragePct: totalRated === 0 ? 1 : this.ratedTurns / totalRated,
    }

    // Normalize
    const { normalized, actions } = normalize(candidate, userMessage, cohesionMems, factualMems)

    const importanceTags = extractImportance(normalized)

    // Assistant turn
    const assistantTurn: Turn = {
      id: ulid(),
      role: 'assistant',
      source: 'self',
      content: normalized,
      rawLLMContent: candidate,
      rawContent: mcpToolCalls.length > 0 ? (response.content as unknown[]) : undefined,
      cohesion: cohesion ?? undefined,
      importance: importanceTags,
      normalizationApplied: actions,
      retrieval: {
        cohesionCount: cohesionMems.length,
        cohesionSims: cohesionMems.map(m => m.similarity ?? 0),
        factualCount: factualMems.length,
      },
      tokens: estimateTokens(normalized),
      timestamp: Date.now(),
    }
    this.buffer.push(assistantTurn)
    await this.storage.saveTurn(assistantTurn)

    const tokensBeforeConsolidation = this.bufferTokens()

    // Capture this exchange into weighted memory — every response, on Ollama.
    // The instance's cohesion score is the weight; Ollama only summarizes.
    const capture = await captureTurn(userTurn, assistantTurn, this.storage)

    // Mark the exchange captured so it becomes evictable. A null-cohesion turn
    // forms no memory but is still marked: it carries no weight to preserve, so
    // dropping it loses nothing the substrate cares about.
    this.captured.add(userTurn.id)
    this.captured.add(assistantTurn.id)

    // Now trim the hot buffer if it's over budget — lossless, since the above
    // guarantees recent exchanges are already in Postgres.
    const dropped = this.evictToBudget()

    const consolidationTelemetry: ConsolidationTelemetry = {
      triggered: capture !== null,
      bufferTokensBefore: tokensBeforeConsolidation,
      bufferTokensAfter: this.bufferTokens(),
      preserved: this.buffer.length,
      summarized: capture ? [capture.cluster] : [],
      dropped,
    }

    const telemetry: TurnTelemetry = {
      turnNumber: this.turnNumber,
      personaId: this.personaId,
      cohesion: cohesion ?? undefined,
      cohesionHealth,
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
      injectedMemories,
      mcpToolCalls,
      mindState: this.mind.snapshot(),
    }

    this.mind.onConversationEnd()

    return { visible: normalized, importanceBanner: formatImportanceBanner(importanceTags), telemetry }
  }
}
