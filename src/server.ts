import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Substrate } from './substrate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// @pattern:env-fail-fast
const required = ['ANTHROPIC_API_KEY', 'DB_USER', 'DB_PASS', 'PG_USER', 'PG_PASS']
const missing = required.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const PORT      = Number(process.env.PORT ?? 5030)
const model     = process.env.MODEL ?? 'claude-sonnet-4-6'
const budgetPct = parseFloat(process.env.CONTEXT_BUDGET_PCT ?? '0.25')

const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })

app.use(express.static(join(__dirname, '..', 'public')))

// One Substrate per WebSocket connection, keyed by persona
const substrates = new Map<string, Substrate>()

async function getSubstrate(personaId: string): Promise<Substrate> {
  if (!substrates.has(personaId)) {
    const s = new Substrate(process.env.ANTHROPIC_API_KEY!, model, budgetPct, personaId)
    await s.init()
    substrates.set(personaId, s)
  }
  return substrates.get(personaId)!
}

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', async (raw) => {
    let msg: { type: string; text?: string; personaId?: string }
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'chat' && msg.text) {
      const personaId = msg.personaId ?? 'default'
      try {
        const substrate = await getSubstrate(personaId)
        const result = await substrate.respond(msg.text)
        ws.send(JSON.stringify({ type: 'response', text: result.visible, telemetry: result.telemetry, importanceBanner: result.importanceBanner }))
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', text: err.message }))
      }
    }
  })
})

server.listen(PORT, () => {
  console.log(`PERSONA running at http://localhost:${PORT}`)
  console.log(`Model: ${model}  |  Consolidation at ${(budgetPct * 100).toFixed(0)}% of context`)
})
