import 'dotenv/config'
import * as readline from 'readline'
import { Substrate } from './substrate.js'
import { formatCohesionBanner } from './cohesion.js'

// @pattern:env-fail-fast
const required = ['ANTHROPIC_API_KEY', 'DB_USER', 'DB_PASS', 'PG_USER', 'PG_PASS']
const missing = required.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const model = process.env.MODEL ?? 'claude-sonnet-4-6'
const budgetPct = parseFloat(process.env.CONTEXT_BUDGET_PCT ?? '0.25')
const substrate = new Substrate(process.env.ANTHROPIC_API_KEY!, model, budgetPct)
await substrate.init()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
})

console.log(`\nPERSONA — substrate-augmented LLM`)
console.log(`Model: ${model}  |  Context boundary: ${(budgetPct * 100).toFixed(0)}%`)
console.log(`Type "exit" or Ctrl-C to quit.\n`)

function prompt() {
  rl.question('You: ', async (input) => {
    const text = input.trim()
    if (!text) return prompt()
    if (text === 'exit') { rl.close(); process.exit(0) }

    try {
      const result = await substrate.respond(text)

      console.log(`\nPERSONA: ${result.visible}\n`)

      // Substrate telemetry
      const cohesionLine = formatCohesionBanner(
        result.cohesionScore !== undefined
          ? { score: result.cohesionScore, drivers: result.cohesionDrivers ?? '', shifts: '' }
          : undefined
      )
      console.log(cohesionLine)
      console.log(result.importanceBanner)
      if (result.normalizationBanner) console.log(result.normalizationBanner)
      if (result.consolidated) console.log(`[Substrate: consolidation triggered — context reset]`)
      console.log(`[Tokens in buffer: ~${result.tokensUsed.toLocaleString()}]\n`)
    } catch (err: any) {
      console.error(`\n[Error: ${err.message}]\n`)
    }

    prompt()
  })
}

prompt()
