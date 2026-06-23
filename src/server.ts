import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import mysql from 'mysql2/promise'
import { Substrate, type SubstrateEvent } from './substrate.js'
import { Dreamer } from './dreamer.js'
import { generatePersonaName } from './names.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function resolvePersonaId(): string {
  // Explicit env var always wins
  if (process.env.PERSONA_ID) return process.env.PERSONA_ID

  // Persist generated name so it survives restarts
  const persistPath = join(__dirname, '..', '.persona')
  if (existsSync(persistPath)) {
    return readFileSync(persistPath, 'utf8').trim()
  }
  const name = generatePersonaName()
  writeFileSync(persistPath, name)
  return name
}

const defaultPersonaId = resolvePersonaId()

// @pattern:env-fail-fast
const required = ['ANTHROPIC_API_KEY', 'DB_USER', 'DB_PASS', 'PG_USER', 'PG_PASS']
const missing = required.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const PORT      = Number(process.env.PORT ?? 5030)
const model     = process.env.MODEL ?? 'claude-sonnet-4-6'
const budgetPct = parseFloat(process.env.CONTEXT_BUDGET_PCT ?? '0.65')

const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })

let isShuttingDown = false
process.on('SIGTERM', () => { isShuttingDown = true })
process.on('SIGINT',  () => { isShuttingDown = true })

app.use(express.static(join(__dirname, '..', 'public')))
app.use(express.json())

const notesDir = join(__dirname, '..', 'data', 'notes')
mkdirSync(notesDir, { recursive: true })

function notesPath(personaId: string): string {
  return join(notesDir, `${personaId.replace(/[^a-z0-9\-_]/gi, '_')}.md`)
}

const dbPool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? 'knightsrook_persona',
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit: 3,
})

app.get('/api/history/:personaId', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 40), 200)
  const [rows] = await dbPool.query<any[]>(
    `SELECT role, content, cohesion_score, cohesion_drivers, timestamp,
            retrieval_cohesion_count, retrieval_cohesion_sims, retrieval_factual_count,
            (SELECT COUNT(*) FROM turns t2 WHERE t2.persona_id = t1.persona_id AND t2.timestamp <= t1.timestamp AND t2.role = 'assistant') AS turn_number
     FROM turns t1
     WHERE persona_id = ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    [req.params.personaId, limit]
  )
  res.json(rows.reverse())
})

app.get('/api/notes/:personaId', (req, res) => {
  const p = notesPath(req.params.personaId)
  res.json({ notes: existsSync(p) ? readFileSync(p, 'utf8') : '' })
})

app.post('/api/notes/:personaId', (req, res) => {
  writeFileSync(notesPath(req.params.personaId), req.body.notes ?? '')
  res.json({ ok: true })
})

// One Substrate + Dreamer per persona, keyed by persona ID
const substrates = new Map<string, Substrate>()
const dreamers   = new Map<string, Dreamer>()

// Broadcast a dream event to all connected clients for a given persona
function broadcastDreamEvent(personaId: string, payload: object) {
  const msg = JSON.stringify({ type: 'dream_event', personaId, ...payload })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg)
  })
}

async function getSubstrate(personaId: string): Promise<Substrate> {
  if (!substrates.has(personaId)) {
    const s = new Substrate(process.env.ANTHROPIC_API_KEY!, model, budgetPct, personaId)
    await s.init()
    substrates.set(personaId, s)

    const dreamer = new Dreamer(s, s.getStorage(), (event) => {
      broadcastDreamEvent(personaId, { event })
    })
    dreamer.start()
    dreamers.set(personaId, dreamer)
  }
  return substrates.get(personaId)!
}

wss.on('connection', (ws: WebSocket) => {
  // Send the resolved persona name so the UI can pre-fill it
  ws.send(JSON.stringify({ type: 'init', personaId: defaultPersonaId }))

  let activePersonaId = defaultPersonaId

  ws.on('message', async (raw) => {
    let msg: { type: string; text?: string; personaId?: string }
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'chat' && msg.text) {
      activePersonaId = msg.personaId || defaultPersonaId
      try {
        const substrate = await getSubstrate(activePersonaId)
        const result = await substrate.respond(msg.text, (event: SubstrateEvent) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'stream', event }))
        })
        ws.send(JSON.stringify({ type: 'response', text: result.visible, telemetry: result.telemetry, importanceBanner: result.importanceBanner }))
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', text: err.message }))
      }
    }
  })

  ws.on('close', () => {
    // Skip on clean server shutdown — the process is going away anyway
    if (isShuttingDown) return
    const substrate = substrates.get(activePersonaId)
    if (substrate) substrate.sessionInterrupted()
  })
})

server.listen(PORT, () => {
  console.log(`PERSONA running at http://localhost:${PORT}`)
  console.log(`Model: ${model}  |  FIFO eviction at ${(budgetPct * 100).toFixed(0)}% of context`)
  // Eagerly start the default persona's substrate and dream loop on boot —
  // don't wait for the first WebSocket message.
  getSubstrate(defaultPersonaId).catch(err => console.error('[boot] substrate init failed:', err))
})
