const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const EMBED_MODEL = 'nomic-embed-text'
// The "dumb" local worker. It never judges cohesion or relevancy — the instance
// already did that in-band. Ollama only writes summary text over the instance's
// tags. See captureTurn in consolidator.ts.
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? 'llama3.2'

export async function embedText(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`)
  const data = await response.json() as any
  return data.embeddings[0]
}

export async function ollamaGenerate(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, prompt, stream: false }),
  })
  if (!response.ok) throw new Error(`Ollama generate error: ${response.status}`)
  const data = await response.json() as any
  return String(data.response ?? '').trim()
}
