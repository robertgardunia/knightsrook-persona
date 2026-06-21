const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const EMBED_MODEL = 'nomic-embed-text'

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
