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
import { captureTurn } from './consolidator.js'
import type { Substrate } from './substrate.js'
import type { Storage } from './storage.js'
import type { Goblin } from './types.js'

const DREAM_INTERVAL_MS  = Number(process.env.DREAM_INTERVAL_MS  ?? 45_000)  // 45s between cycles
const GOBLIN_MAX_ATTEMPTS = Number(process.env.GOBLIN_MAX_ATTEMPTS ?? 3)      // fade after this many failures

type DreamCycleResult = {
  type: 'dream' | 'goblin'
  thought: string
  coherence: number
  goblinId?: string
  resolved?: boolean
}

export type DreamEvent = {
  type: 'dream_cycle'
  result: DreamCycleResult
  mindState: ReturnType<Substrate['mindSnapshot']>
  timestamp: number
}

export class Dreamer {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private goblinAttempts = new Map<string, number>()

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
    this.timer = setTimeout(() => {
      this.cycle().catch(err => console.error('[dreamer] cycle error:', err))
        .finally(() => this.schedule())
    }, DREAM_INTERVAL_MS)
  }

  private async cycle(): Promise<void> {
    const snap = this.substrate.mindSnapshot()

    // Yield during active conversation or forced refractory
    if (snap.state === 'conversation' || snap.state === 'refractory') return

    let result: DreamCycleResult | null = null

    if (snap.state === 'goblin' && snap.activeGoblins.length > 0) {
      result = await this.goblinCycle(snap.activeGoblins[0])
    } else {
      result = await this.dreamCycle()
    }

    if (!result) return

    // Save as internal turn — not pushed to hot buffer, not seen in conversation
    const internalTurn = {
      id: ulid(),
      role: 'assistant' as const,
      source: 'internal' as const,
      content: result.thought,
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
    this.onEvent?.({ type: 'dream_cycle', result, mindState, timestamp: Date.now() })

    console.log(`[dreamer] ${result.type} cycle — coherence ${result.coherence}/10 — ${result.thought.slice(0, 80)}`)
  }

  private async dreamCycle(): Promise<DreamCycleResult | null> {
    // Pull recent warm memories for free association
    const mems = await this.storage.retrieveRecentHighCohesion(6)
    if (mems.length === 0) return null

    const memText = mems.map((m, i) => `${i + 1}. [${m.cluster}] ${m.summary}`).join('\n')

    const prompt =
      `You are doing self-directed free association between memory fragments.\n\n` +
      `Recent memories:\n${memText}\n\n` +
      `Make one brief, genuine association — a connection you notice between any of these, ` +
      `or a thread worth following. This is internal processing, not a response to anyone.\n\n` +
      `Reply with JSON only, no other text:\n{"thought":"...","coherence":<integer 1-10>}`

    const raw = await cognize(prompt, { temperature: 0.8, maxTokens: 200 })

    try {
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as { thought: string; coherence: number }
      return { type: 'dream', thought: parsed.thought, coherence: Number(parsed.coherence) || 5 }
    } catch {
      console.warn('[dreamer] dream parse failure:', raw.slice(0, 100))
      return null
    }
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
      `A broken connection was flagged in memory: "${goblin.trigger}"\n\n` +
      `Attempt to reason about what's missing or what would repair this. ` +
      `Be honest — if you cannot resolve it, say so.\n\n` +
      `Reply with JSON only, no other text:\n` +
      `{"attempt":"...","confidence":<integer 1-10>,"resolved":<true or false>}`

    const raw = await cognize(prompt, { temperature: 0.5, maxTokens: 200 })

    try {
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as {
        attempt: string; confidence: number; resolved: boolean
      }

      if (parsed.resolved && Number(parsed.confidence) >= 6) {
        this.substrate.resolveGoblin(goblin.id)
        this.goblinAttempts.delete(goblin.id)
      }

      return {
        type: 'goblin',
        thought: parsed.attempt,
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
