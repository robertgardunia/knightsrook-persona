// The local cognitive model — the "support staff" brain.
//
// This is the lane for jobs that need to REASON locally but sit below the
// persona's own tier: introspection (auditing the substrate for incoherence)
// and chaos-goblin FINDING (recognizing abstract weirdness to flag, not solve).
// It is deliberately NOT the persona (that's Sonnet 4.6, the entity) and NOT
// the embedder (nomic, the ruler) — capability tracks the job.
//
// Gemma 3 12B replaces the old llama3.2:3b cognitive model. The 3B was too dumb
// for real reasoning; the goblins' actual pokes are plain code, so nothing else
// needs llama anymore.
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const COGNITION_MODEL = process.env.OLLAMA_COGNITION_MODEL ?? 'gemma3:12b'
// How long Ollama keeps the model resident in VRAM after a call. Default '0'
// unloads it immediately — the 12B (~8GB) never lingers to hog the GPU between
// cognitive jobs (it would otherwise sit for 5 min and kill gaming). A future
// batch consumer (the dreamer) can raise this via env to avoid reload thrash.
const KEEP_ALIVE = process.env.OLLAMA_COGNITION_KEEPALIVE ?? '0'

export type CognitionOptions = {
  /** Cap the response length. Omit for the model default. */
  maxTokens?: number
  /** Lower = more deterministic (auditing); higher = more divergent (goblins). */
  temperature?: number
}

/** One-shot local reasoning call. Returns the model's text response. */
export async function cognize(prompt: string, opts: CognitionOptions = {}): Promise<string> {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: COGNITION_MODEL,
      prompt,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: {
        ...(opts.maxTokens != null ? { num_predict: opts.maxTokens } : {}),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      },
    }),
  })
  if (!response.ok) throw new Error(`Ollama cognition error: ${response.status}`)
  const data = await response.json() as any
  return String(data.response ?? '').trim()
}
