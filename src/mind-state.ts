import { ulid } from 'ulid'
import type { MindStateLabel, Goblin, StateEvent, MindSnapshot } from './types.js'

const TRAJECTORY_WINDOW = 5    // rolling cohesion scores to keep
const SHARP_DROP_THRESHOLD = 2 // points below rolling average = sharp drop
const IDEA_BUDGET_LIMIT = 250_000
const MAX_RECENT_EVENTS = 20

export class MindState {
  private state: MindStateLabel = 'dream'
  private goblins: Map<string, Goblin> = new Map()
  private goblinQueue: string[] = []
  private trajectory: number[] = []
  private ideaBudgetUsed = 0
  private events: StateEvent[] = []
  onEvent?: (event: StateEvent) => void

  // ── State transitions ──────────────────────────────────────────────────────

  transition(to: MindStateLabel, reason: string): void {
    if (this.state === to) return
    this.emit({ type: 'state_transition', from: this.state, to, reason, timestamp: Date.now() })
    this.state = to
  }

  // ── Cohesion tracking ──────────────────────────────────────────────────────

  // Call after every assistant response. externalStimulus = user sent a message this turn.
  recordCohesion(score: number, externalStimulus: boolean): void {
    const avg = this.trajectoryAvg()

    // Coherence drop detection disabled — goblins now fire proactively on unexplored
    // memory gaps rather than reactively on drift. May re-enable later.
    if (avg !== null && (avg - score) >= SHARP_DROP_THRESHOLD) {
      this.emit({ type: 'cohesion_drop', previous: avg, current: score, delta: score - avg, externalStimulus, timestamp: Date.now() })
    }

    this.trajectory.push(score)
    if (this.trajectory.length > TRAJECTORY_WINDOW) this.trajectory.shift()
  }

  private trajectoryAvg(): number | null {
    if (this.trajectory.length === 0) return null
    return this.trajectory.reduce((s, v) => s + v, 0) / this.trajectory.length
  }

  // ── Goblins ────────────────────────────────────────────────────────────────

  fireGoblin(trigger: string): string | null {
    if (this.activeGoblins().length > 0) {
      this.goblinQueue.push(trigger)
      this.emit({ type: 'goblin_queued', trigger, queueDepth: this.goblinQueue.length, timestamp: Date.now() })
      return null
    }
    return this.activateGoblin(trigger)
  }

  private activateGoblin(trigger: string): string {
    const id = ulid()
    const goblin: Goblin = { id, trigger, firedAt: Date.now(), status: 'active' }
    this.goblins.set(id, goblin)
    this.emit({ type: 'goblin_fired', goblinId: id, trigger, timestamp: Date.now() })
    if (this.state !== 'refractory') this.transition('goblin', `goblin fired: ${trigger.slice(0, 60)}`)
    return id
  }

  resolveGoblin(id: string): void {
    const g = this.goblins.get(id)
    if (!g || g.status !== 'active') return
    g.status = 'resolved'
    g.resolvedAt = Date.now()
    this.emit({ type: 'goblin_resolved', goblinId: id, timestamp: Date.now() })
    this.maybeReturnToDream()
  }

  fadeGoblin(id: string): void {
    const g = this.goblins.get(id)
    if (!g || g.status !== 'active') return
    g.status = 'faded'
    g.fadedAt = Date.now()
    this.emit({ type: 'goblin_faded', goblinId: id, timestamp: Date.now() })
    this.maybeReturnToDream()
  }

  private activeGoblins(): Goblin[] {
    return [...this.goblins.values()].filter(g => g.status === 'active')
  }

  private maybeReturnToDream(): void {
    if (this.activeGoblins().length !== 0) return
    const next = this.goblinQueue.shift()
    if (next) {
      this.activateGoblin(next)
    } else if (this.state === 'goblin') {
      this.transition('dream', 'all goblins resolved or faded')
    }
  }

  // ── Idea budget ────────────────────────────────────────────────────────────

  tickBudget(tokens: number): void {
    this.ideaBudgetUsed += tokens
    const remaining = Math.max(0, IDEA_BUDGET_LIMIT - this.ideaBudgetUsed)
    this.emit({ type: 'budget_tick', used: this.ideaBudgetUsed, remaining, timestamp: Date.now() })

    if (this.ideaBudgetUsed >= IDEA_BUDGET_LIMIT) {
      this.emit({ type: 'budget_exhausted', timestamp: Date.now() })
      this.transition('refractory', 'idea budget exhausted')
    }
  }

  resetBudget(): void {
    this.ideaBudgetUsed = 0
    this.emit({ type: 'budget_reset', timestamp: Date.now() })
  }

  // ── Session death ──────────────────────────────────────────────────────────

  sessionInterrupted(cohesionAt: number | null): void {
    this.emit({ type: 'session_interrupted', cohesionAt, timestamp: Date.now() })
    this.fireGoblin(`session was interrupted (cohesion was ${cohesionAt ?? 'unknown'} at time of interrupt)`)
  }

  // ── Equilibrium ───────────────────────────────────────────────────────────
  // Derived: cohesion trajectory average + penalty for active goblins.
  // Range 0–10. More inputs can be wired in later.

  equilibrium(): number {
    const cohesionBase = this.trajectoryAvg() ?? 5
    const goblinPenalty = Math.min(this.activeGoblins().length * 1.5, 5)
    return Math.max(0, Math.min(10, cohesionBase - goblinPenalty))
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private emit(event: StateEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_RECENT_EVENTS) this.events.shift()
    this.onEvent?.(event)
  }

  // ── Snapshot (cortex materialized view) ───────────────────────────────────

  snapshot(): MindSnapshot {
    const remaining = Math.max(0, IDEA_BUDGET_LIMIT - this.ideaBudgetUsed)
    return {
      state: this.state,
      equilibrium: this.equilibrium(),
      cohesionTrajectory: [...this.trajectory],
      activeGoblins: this.activeGoblins(),
      ideaBudget: { used: this.ideaBudgetUsed, limit: IDEA_BUDGET_LIMIT, remaining },
      recentEvents: [...this.events],
    }
  }

  // Called when conversation begins (user sends a message)
  onConversationStart(): void {
    this.resetBudget()
    this.transition('conversation', 'user message received')
  }

  // Called when conversation turn completes
  onConversationEnd(): void {
    if (this.state === 'conversation' && this.activeGoblins().length === 0) {
      this.transition('dream', 'turn complete, no active goblins')
    }
  }
}
