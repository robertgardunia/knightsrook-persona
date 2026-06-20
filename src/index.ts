import 'dotenv/config'
import * as readline from 'readline'
import { Substrate } from './substrate.js'
import { renderTelemetry } from './telemetry.js'

// @pattern:env-fail-fast
const required = ['ANTHROPIC_API_KEY', 'DB_USER', 'DB_PASS', 'PG_USER', 'PG_PASS']
const missing = required.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const model = process.env.MODEL ?? 'claude-sonnet-4-6'
const budgetPct = parseFloat(process.env.CONTEXT_BUDGET_PCT ?? '0.25')
const personaId = process.env.PERSONA_ID ?? 'default'

const substrate = new Substrate(process.env.ANTHROPIC_API_KEY!, model, budgetPct, personaId)
await substrate.init()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
})

console.log(`\n${'═'.repeat(56)}`)
console.log(` PERSONA  ·  substrate-augmented LLM`)
console.log(`${'─'.repeat(56)}`)
console.log(` persona  : ${personaId}`)
console.log(` model    : ${model}`)
console.log(` context  : consolidation at ${(budgetPct * 100).toFixed(0)}% of window`)
console.log(`${'═'.repeat(56)}\n`)
console.log(`Type "exit" or Ctrl-C to quit.\n`)

function prompt() {
  rl.question('You: ', async (input) => {
    const text = input.trim()
    if (!text) return prompt()
    if (text === 'exit') { rl.close(); process.exit(0) }

    try {
      const result = await substrate.respond(text)

      console.log(`\nPERSONA: ${result.visible}\n`)
      console.log(result.importanceBanner)
      console.log(renderTelemetry(result.telemetry))
    } catch (err: any) {
      console.error(`\n[Error: ${err.message}]\n`)
    }

    prompt()
  })
}

prompt()
