/** One-shot: talk to a persona on a FRESH process (empty hot buffer) and show
 * what retrieval drags back in. The only thing carrying continuity is the
 * cohesion-weighted memories in Postgres. */
import 'dotenv/config'
import { Substrate } from '../src/substrate.js'

const personaId = process.argv[2] ?? 'nested-zenith'
const message = process.argv[3] ?? "Hey, I'm back. Remind me where we landed on the band concept?"

async function main() {
  const s = new Substrate(
    process.env.ANTHROPIC_API_KEY!,
    process.env.MODEL ?? 'claude-sonnet-4-6',
    parseFloat(process.env.CONTEXT_BUDGET_PCT ?? '0.65'),
    personaId,
  )
  await s.init()

  console.log(`\n=== FRESH RESTART — persona: ${personaId} ===`)
  console.log(`You: ${message}\n`)

  const r = await s.respond(message)
  const t = r.telemetry

  console.log('--- RETRIEVAL (what the empty buffer pulled from Postgres) ---')
  console.log(`  cohesion memories matched: ${t.retrieval.cohesion.count}`)
  console.log(`  similarities: ${t.retrieval.cohesion.similarities.map(x => x.toFixed(3)).join(', ') || '—'}`)
  console.log(`  factual hits: ${t.retrieval.factual.count}`)
  console.log()
  console.log('--- PERSONA RESPONSE ---')
  console.log(r.visible)
  console.log()
  console.log('--- THIS TURN ---')
  console.log(`  cohesion: ${t.cohesion ? `${t.cohesion.score}/10 — ${t.cohesion.drivers}` : 'none'}`)
  console.log(`  coverage: ${(t.cohesionHealth.coveragePct * 100).toFixed(0)}%`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
