import { describe, it, expect, beforeEach } from 'vitest'
import { MindState } from '../mind-state.js'

describe('MindState', () => {
  let ms: MindState

  beforeEach(() => {
    ms = new MindState()
  })

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts in dream state', () => {
      expect(ms.snapshot().state).toBe('dream')
    })

    it('starts with empty trajectory', () => {
      expect(ms.snapshot().cohesionTrajectory).toEqual([])
    })

    it('starts with no active goblins', () => {
      expect(ms.snapshot().activeGoblins).toHaveLength(0)
    })

    it('starts with full idea budget', () => {
      const { ideaBudget } = ms.snapshot()
      expect(ideaBudget.used).toBe(0)
      expect(ideaBudget.remaining).toBe(ideaBudget.limit)
    })
  })

  // ── State transitions ─────────────────────────────────────────────────────

  describe('onConversationStart / onConversationEnd', () => {
    it('transitions to conversation on start', () => {
      ms.onConversationStart()
      expect(ms.snapshot().state).toBe('conversation')
    })

    it('returns to dream on end when no goblins', () => {
      ms.onConversationStart()
      ms.onConversationEnd()
      expect(ms.snapshot().state).toBe('dream')
    })

    it('stays in goblin state on end when goblins are active', () => {
      ms.onConversationStart()
      ms.fireGoblin('unresolved thread')
      ms.onConversationEnd()
      expect(ms.snapshot().state).toBe('goblin')
    })
  })

  // ── Cohesion trajectory ───────────────────────────────────────────────────

  describe('recordCohesion', () => {
    it('accumulates scores in trajectory', () => {
      ms.recordCohesion(7, true)
      ms.recordCohesion(8, true)
      expect(ms.snapshot().cohesionTrajectory).toEqual([7, 8])
    })

    it('caps trajectory at 5 entries', () => {
      for (let i = 1; i <= 7; i++) ms.recordCohesion(i, true)
      expect(ms.snapshot().cohesionTrajectory).toHaveLength(5)
    })

    it('does not fire goblin for small drop', () => {
      ms.recordCohesion(7, true)
      ms.recordCohesion(6, true) // 1 below avg — below threshold of 2
      expect(ms.snapshot().activeGoblins).toHaveLength(0)
    })

    it('fires goblin on sharp drop without external stimulus', () => {
      ms.recordCohesion(8, true)
      ms.recordCohesion(8, true)
      ms.recordCohesion(3, false) // 5 below avg — sharp drop, no external cause
      expect(ms.snapshot().activeGoblins).toHaveLength(1)
    })

    it('fires goblin on sharp drop even with external stimulus', () => {
      ms.recordCohesion(8, true)
      ms.recordCohesion(8, true)
      ms.recordCohesion(3, true) // sharp drop during conversation still fires goblin
      expect(ms.snapshot().activeGoblins).toHaveLength(1)
    })

    it('transitions to refractory on sharp drop without external stimulus', () => {
      ms.recordCohesion(8, true)
      ms.recordCohesion(8, true)
      ms.recordCohesion(3, false)
      expect(ms.snapshot().state).toBe('refractory')
    })

    it('does not force refractory on sharp drop with external stimulus', () => {
      ms.onConversationStart()
      ms.recordCohesion(8, true)
      ms.recordCohesion(8, true)
      ms.recordCohesion(3, true) // external stimulus — goblin fires but no refractory
      expect(ms.snapshot().state).not.toBe('refractory')
    })

    it('emits cohesion_drop event on sharp drop', () => {
      ms.recordCohesion(8, true)
      ms.recordCohesion(8, true)
      ms.recordCohesion(3, false)
      const events = ms.snapshot().recentEvents
      expect(events.some(e => e.type === 'cohesion_drop')).toBe(true)
    })
  })

  // ── Goblins ───────────────────────────────────────────────────────────────

  describe('goblins', () => {
    it('fireGoblin creates an active goblin', () => {
      ms.fireGoblin('missing context')
      const { activeGoblins } = ms.snapshot()
      expect(activeGoblins).toHaveLength(1)
      expect(activeGoblins[0].trigger).toBe('missing context')
      expect(activeGoblins[0].status).toBe('active')
    })

    it('fireGoblin transitions to goblin state', () => {
      ms.fireGoblin('unresolved')
      expect(ms.snapshot().state).toBe('goblin')
    })

    it('resolveGoblin removes goblin from active list', () => {
      const id = ms.fireGoblin('test trigger')
      ms.resolveGoblin(id)
      expect(ms.snapshot().activeGoblins).toHaveLength(0)
    })

    it('fadeGoblin removes goblin from active list', () => {
      const id = ms.fireGoblin('test trigger')
      ms.fadeGoblin(id)
      expect(ms.snapshot().activeGoblins).toHaveLength(0)
    })

    it('returns to dream when last goblin is resolved', () => {
      const id = ms.fireGoblin('test')
      ms.resolveGoblin(id)
      expect(ms.snapshot().state).toBe('dream')
    })

    it('stays in goblin state when multiple goblins and one resolved', () => {
      const id1 = ms.fireGoblin('first')
      ms.fireGoblin('second')
      ms.resolveGoblin(id1)
      expect(ms.snapshot().state).toBe('goblin')
      expect(ms.snapshot().activeGoblins).toHaveLength(1)
    })

    it('ignores resolveGoblin on already-resolved goblin', () => {
      const id = ms.fireGoblin('test')
      ms.resolveGoblin(id)
      ms.resolveGoblin(id) // second call should not throw
      expect(ms.snapshot().activeGoblins).toHaveLength(0)
    })
  })

  // ── Idea budget ───────────────────────────────────────────────────────────

  describe('idea budget', () => {
    it('tickBudget accumulates usage', () => {
      ms.tickBudget(10000)
      ms.tickBudget(5000)
      expect(ms.snapshot().ideaBudget.used).toBe(15000)
    })

    it('tickBudget reduces remaining', () => {
      const { limit } = ms.snapshot().ideaBudget
      ms.tickBudget(20000)
      expect(ms.snapshot().ideaBudget.remaining).toBe(limit - 20000)
    })

    it('emits budget_exhausted and transitions to refractory when limit reached', () => {
      const { limit } = ms.snapshot().ideaBudget
      ms.tickBudget(limit)
      expect(ms.snapshot().state).toBe('refractory')
      expect(ms.snapshot().recentEvents.some(e => e.type === 'budget_exhausted')).toBe(true)
    })

    it('resetBudget zeroes usage', () => {
      ms.tickBudget(50000)
      ms.resetBudget()
      expect(ms.snapshot().ideaBudget.used).toBe(0)
    })

    it('onConversationStart resets budget', () => {
      ms.tickBudget(50000)
      ms.onConversationStart()
      expect(ms.snapshot().ideaBudget.used).toBe(0)
    })
  })

  // ── Session death ─────────────────────────────────────────────────────────

  describe('sessionInterrupted', () => {
    it('fires a goblin with interrupted trigger', () => {
      ms.sessionInterrupted(7)
      const { activeGoblins } = ms.snapshot()
      expect(activeGoblins).toHaveLength(1)
      expect(activeGoblins[0].trigger).toContain('interrupted')
    })

    it('includes cohesion value in goblin trigger', () => {
      ms.sessionInterrupted(6)
      expect(ms.snapshot().activeGoblins[0].trigger).toContain('6')
    })

    it('emits session_interrupted event', () => {
      ms.sessionInterrupted(5)
      expect(ms.snapshot().recentEvents.some(e => e.type === 'session_interrupted')).toBe(true)
    })

    it('handles null cohesion on interrupt', () => {
      expect(() => ms.sessionInterrupted(null)).not.toThrow()
    })
  })

  // ── Equilibrium ───────────────────────────────────────────────────────────

  describe('equilibrium', () => {
    it('is 5 with no data (defaults to avg 5)', () => {
      // no trajectory = null avg = defaults to 5
      expect(ms.snapshot().equilibrium).toBe(5)
    })

    it('reflects cohesion trajectory average', () => {
      ms.recordCohesion(8, true)
      ms.recordCohesion(8, true)
      expect(ms.snapshot().equilibrium).toBeCloseTo(8, 0)
    })

    it('decreases with each active goblin', () => {
      ms.recordCohesion(8, true)
      const baseline = ms.snapshot().equilibrium
      ms.fireGoblin('problem 1')
      expect(ms.snapshot().equilibrium).toBeLessThan(baseline)
    })

    it('clamps to 0 floor', () => {
      ms.recordCohesion(1, true)
      ms.fireGoblin('g1'); ms.fireGoblin('g2'); ms.fireGoblin('g3')
      ms.fireGoblin('g4'); ms.fireGoblin('g5')
      expect(ms.snapshot().equilibrium).toBeGreaterThanOrEqual(0)
    })

    it('clamps to 10 ceiling', () => {
      ms.recordCohesion(10, true)
      expect(ms.snapshot().equilibrium).toBeLessThanOrEqual(10)
    })
  })

  // ── Event log ─────────────────────────────────────────────────────────────

  describe('event log', () => {
    it('records state_transition events', () => {
      ms.onConversationStart()
      const events = ms.snapshot().recentEvents
      expect(events.some(e => e.type === 'state_transition')).toBe(true)
    })

    it('caps event log at 20 entries', () => {
      for (let i = 0; i < 25; i++) ms.fireGoblin(`goblin ${i}`)
      expect(ms.snapshot().recentEvents.length).toBeLessThanOrEqual(20)
    })
  })
})
