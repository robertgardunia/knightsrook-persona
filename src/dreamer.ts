// The dream loop — self-directed activity between conversations.
//
// Runs as a background process attached to a Substrate. When the mind is in
// 'dream' state it free-associates across recent memories. When in 'goblin'
// state it pokes at broken edges, attempting resolution or fading after repeated
// failures. In 'conversation' or 'refractory' it yields immediately.
//
// Cognition uses the local Gemma 3 12B (via cognition.ts) — NOT the Anthropic
// API. Dream activity is substrate-internal; it doesn't need the persona model.
// Output is saved as source:'internal' turns and consolidated into Postgres
// memory, but never pushed into the hot conversation buffer.

import { ulid } from 'ulid'
import { cognize } from './cognition.js'
import { embedText } from './embeddings.js'
import { captureTurn } from './consolidator.js'
import type { Substrate } from './substrate.js'
import type { Storage } from './storage.js'
import type { Goblin } from './types.js'

const DREAM_INTERVAL_MS      = Number(process.env.DREAM_INTERVAL_MS  ?? 45_000)
const GOBLIN_MAX_ATTEMPTS    = Number(process.env.GOBLIN_MAX_ATTEMPTS ?? 3)
const CHAIN_MAX_STEPS        = 4    // max hops per dream chain
const PROACTIVE_GOBLIN_EVERY = 20   // every N dream cycles, scan for unexplored memories

// Gemma wraps JSON in ```json fences — strip them before parsing.
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const braced = raw.match(/\{[\s\S]*\}/)
  return braced ? braced[0] : raw
}

type ChainStep = { node: string; why: string; cohesion: number }

type DreamCycleResult = {
  type: 'dream' | 'goblin'
  thought: string
  seedNode: string
  coherence: number
  goblinId?: string
  resolved?: boolean
}

export type DreamEvent = {
  type: 'dream_cycle'
  result: DreamCycleResult
  mindState: ReturnType<Substrate['mindSnapshot']>
  confidenceStats: { avg: number; explored: number; total: number }
  timestamp: number
}

export class Dreamer {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private goblinAttempts = new Map<string, number>()
  private dreamCycleCount = 0

  constructor(
    private substrate: Substrate,
    private storage: Storage,
    private onEvent?: (e: DreamEvent) => void
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private schedule(): void {
    if (!this.running) return
    // No artificial delay between dreams — one chain ends, the next begins.
    // The chain itself (LLM calls + embedding) provides natural pacing.
    // A brief yield keeps the event loop from starving other work.
    this.timer = setTimeout(() => {
      this.cycle().catch(err => console.error('[dreamer] cycle error:', err))
        .finally(() => this.schedule())
    }, 500)
  }

  private async cycle(): Promise<void> {
    const snap = this.substrate.mindSnapshot()

    // Yield during active conversation or forced refractory
    if (snap.state === 'conversation' || snap.state === 'refractory') return

    let result: DreamCycleResult | null = null

    if (snap.state === 'goblin' && snap.activeGoblins.length > 0) {
      result = await this.goblinCycle(snap.activeGoblins[0])
    } else {
      // Every N dream cycles, proactively scan for unexplored memories and spawn a goblin
      this.dreamCycleCount++
      if (this.dreamCycleCount % PROACTIVE_GOBLIN_EVERY === 0) {
        const unexplored = await this.storage.retrieveUnexplored(1)
        if (unexplored.length > 0) {
          const mem = unexplored[0]
          const id = this.substrate.fireGoblin(`unexplored memory: [${mem.cluster}] ${mem.summary.slice(0, 80)}`)
          if (id) console.log(`[dreamer] proactive goblin fired for unexplored: ${mem.cluster.slice(0, 60)}`)
        }
      }
      result = await this.dreamCycle()
    }

    if (!result) return

    // Save as internal turn — not pushed to hot buffer, not seen in conversation.
    // Attach a cohesion rating from Gemma's self-assessment so captureTurn
    // embeds it and it becomes retrievable via vector similarity.
    const internalTurn = {
      id: ulid(),
      role: 'assistant' as const,
      source: 'internal' as const,
      content: result.thought,
      cohesion: {
        score: result.coherence,
        drivers: result.type === 'goblin'
          ? `goblin poke: ${result.thought.slice(0, 60)}`
          : result.seedNode,
        shifts: result.type === 'goblin' && result.resolved
          ? 'broken edge repaired'
          : result.type === 'goblin'
            ? 'broken edge unresolved'
            : 'new association formed',
      },
      tokens: Math.ceil(result.thought.length / 4),
      timestamp: Date.now(),
    }

    // Synthetic user stub so captureTurn has a pair to work with
    const stub = {
      id: ulid(),
      role: 'user' as const,
      source: 'internal' as const,
      content: `[${result.type === 'goblin' ? 'goblin poke' : 'dream cycle'}]`,
      tokens: 10,
      timestamp: Date.now() - 1,
    }

    await this.storage.saveTurn(internalTurn)

    // Tick budget — dream activity consumes the idea budget
    this.substrate.tickDreamBudget(internalTurn.tokens)

    // Record cohesion — no external stimulus, so sharp drops trigger veto
    this.substrate.recordDreamCohesion(result.coherence)

    // Consolidate into Postgres memory so dream associations become retrievable
    await captureTurn(stub, internalTurn, this.storage)

    const mindState = this.substrate.mindSnapshot()
    const confidenceStats = await this.storage.confidenceStats()
    this.onEvent?.({ type: 'dream_cycle', result, mindState, confidenceStats, timestamp: Date.now() })

    console.log(`[dreamer] ${result.type} cycle — coherence ${result.coherence}/10 — ${result.thought.slice(0, 80)}`)
  }

  private async dreamCycle(): Promise<DreamCycleResult | null> {
    // Random entry point — no pre-filtering, let the chain find its own path
    const seed = await this.storage.retrieveDreamSeed()
    if (!seed) return null

    const snap = this.substrate.mindSnapshot()
    const equilibrium = snap.equilibrium

    const chain: ChainStep[] = []
    const visitedIds: string[] = [seed.id]
    let current = seed
    let currentEmbedding = await embedText(current.summary)

    for (let step = 0; step < CHAIN_MAX_STEPS; step++) {
      // Find nearest neighbours to current node, excluding already visited
      const neighbours = await this.storage.retrieveNearestTo(currentEmbedding, visitedIds, 4)
      const neighbourText = neighbours.map((m, i) =>
        `${i + 1}. [${m.cluster}] ${m.summary}`
      ).join('\n')

      const settledHint = equilibrium >= 7
        ? 'Equilibrium is high — feel free to drift and explore freely.'
        : equilibrium <= 4
          ? 'Equilibrium is low — look for what feels broken or unresolved.'
          : ''

      const prompt =
        `You are integrating memories. Work only with what is written below — do not introduce facts, people, events, or concepts not present in these nodes.\n\n` +
        `Current node:\n[${current.cluster}] ${current.summary}\n\n` +
        `Nearby nodes:\n${neighbourText}\n\n` +
        `${settledHint}\n\n` +
        `Either:\n` +
        `- Move to one of the nearby nodes if you see a genuine connection between them (name the specific node)\n` +
        `- Stay here and articulate something implicit in this node that isn't stated directly\n` +
        `- Let the chain end here if it feels complete\n\n` +
        `Constraint: your "node" and "why" must be grounded in the text above. Do not add external knowledge.\n\n` +
        `Reply with JSON only:\n` +
        `{"node":"<what you're focusing on now>","why":"<what connection or insight, grounded in the memory text>","cohesion":<1-10>,"continue":<true|false>}`

      const raw = await cognize(prompt, { temperature: 0.75, maxTokens: 250 })

      try {
        const parsed = JSON.parse(extractJson(raw)) as {
          node: string; why: string; cohesion: number; continue: boolean
        }
        const stepCohesion = Number(parsed.cohesion) || 5
        chain.push({ node: parsed.node, why: parsed.why, cohesion: stepCohesion })

        // Update confidence of the node we just stepped from.
        // High cohesion = well-integrated (+), low cohesion = shaky (-).
        const confidenceDelta = stepCohesion >= 8 ? 0.05 : stepCohesion >= 6 ? 0.01 : -0.03
        await this.storage.updateConfidence(current.id, confidenceDelta)

        if (!parsed.continue) break

        // Move to the most relevant neighbour by re-embedding the current thought
        if (neighbours.length > 0) {
          currentEmbedding = await embedText(parsed.node + ' ' + parsed.why)
          // Pick the neighbour closest to where Gemma said it was going
          const closest = neighbours[0]
          visitedIds.push(closest.id)
          current = closest
        } else {
          break
        }
      } catch {
        console.warn('[dreamer] chain step parse failure:', raw.slice(0, 80))
        break
      }
    }

    if (chain.length === 0) return null

    // The full chain is the thought — traversal path preserved
    const thought = chain.map((s, i) => `${i + 1}. ${s.node} — ${s.why}`).join('\n')
    const coherence = Math.round(chain.reduce((s, c) => s + c.cohesion, 0) / chain.length)
    const seedNode = chain[0].node.slice(0, 60)

    return { type: 'dream', thought, seedNode, coherence }
  }

  private async goblinCycle(goblin: Goblin): Promise<DreamCycleResult | null> {
    const attempts = (this.goblinAttempts.get(goblin.id) ?? 0) + 1
    this.goblinAttempts.set(goblin.id, attempts)

    // Fade after too many failed attempts — the broken edge isn't repairable right now
    if (attempts > GOBLIN_MAX_ATTEMPTS) {
      this.substrate.fadeGoblin(goblin.id)
      this.goblinAttempts.delete(goblin.id)
      console.log(`[dreamer] goblin ${goblin.id.slice(-6)} faded after ${attempts - 1} attempts`)
      return null
    }

    const prompt =
      `A gap or broken connection was flagged in memory: "${goblin.trigger}"\n\n` +
      `Reason about what is missing or unresolved using only what the memory text implies. ` +
      `Do not introduce facts, people, or events from outside the memory. ` +
      `If you cannot resolve it from what is already there, say so — an honest "unresolved" is correct output.\n\n` +
      `Reply with JSON only, no other text:\n` +
      `{"attempt":"...","confidence":<integer 1-10>,"resolved":<true or false>}`

    const raw = await cognize(prompt, { temperature: 0.5, maxTokens: 400 })

    try {
      const parsed = JSON.parse(extractJson(raw)) as {
        attempt: string; confidence: number; resolved: boolean
      }

      if (parsed.resolved && Number(parsed.confidence) >= 6) {
        this.substrate.resolveGoblin(goblin.id)
        this.goblinAttempts.delete(goblin.id)
      }

      return {
        type: 'goblin',
        thought: parsed.attempt,
        seedNode: parsed.attempt.slice(0, 60),
        coherence: Number(parsed.confidence) || 4,
        goblinId: goblin.id,
        resolved: parsed.resolved,
      }
    } catch {
      console.warn('[dreamer] goblin parse failure:', raw.slice(0, 100))
      return null
    }
  }
}
