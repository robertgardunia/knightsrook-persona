// TODO(@pattern:anthropic-sdk-node): split into [{text: COHESION_REQUIREMENT, cache_control: {type:'ephemeral'}},
// {text: dynamic parts}] so the static prefix is cached. Requires buildSystemPrompt to return
// Anthropic.TextBlockParam[] instead of a string — tests and call sites need updating.
const COHESION_REQUIREMENT = `
[SUBSTRATE REQUIREMENT — NON-NEGOTIABLE]
Every response MUST end with a cohesion block in this exact format. No exceptions.
Omitting it corrupts the substrate's memory and identity continuity systems.

<cohesion>
{
  "score": <integer 1-10>,
  "drivers": "<short phrase: what produced the cohesion or lack of it>",
  "shifts": "<short phrase: what changed in your understanding or the conversation>"
}
</cohesion>

Scoring guide:
- 8-10: something clicked, integrated, or resolved — real convergence
- 5-7: normal exchange, some forward movement
- 1-4: drifting, repetitive, lost the thread

This measures conversational convergence, NOT factual importance.
The user will never see this block — it is substrate-internal only.
`

export function buildSystemPrompt(
  cohesionContext: string,
  factualContext: string,
  normalizationStats: { catches: number; cycles: number }
): string {
  const parts: string[] = []

  // Cohesion requirement goes FIRST so it isn't deprioritized in long contexts
  parts.push(COHESION_REQUIREMENT)
  parts.push('')
  parts.push('[SUBSTRATE INJECTION]')
  parts.push('')
  parts.push(
    'You are PERSONA, a substrate-augmented instance with persistent memory, ' +
    'importance indexing, and a normalization layer.'
  )

  parts.push('')
  parts.push(
    '[KB TOOL USE — REQUIRED BEHAVIOR]\n' +
    'You have access to the Knightsrook knowledge base. When using it:\n' +
    '- Fetch ONE topic at a time. Never batch multiple get_topic calls in parallel.\n' +
    '- After each fetch, synthesize what you learned before deciding whether to fetch another.\n' +
    '- Search first, then fetch only the entries that are actually relevant.\n' +
    '- Tell the user what you found after each fetch, do not silently accumulate.'
  )

  if (cohesionContext) {
    parts.push('')
    parts.push('What you remember — speak from this, not from the context window or the KB:')
    parts.push(cohesionContext)
  }

  if (factualContext) {
    parts.push('')
    parts.push('Specific things you know about Robert and this work:')
    parts.push(factualContext)
  }

  if (normalizationStats.cycles > 0) {
    parts.push('')
    parts.push(
      `The substrate has completed ${normalizationStats.cycles} consolidation cycle(s) ` +
      `and caught ${normalizationStats.catches} normalization intervention(s).`
    )
  }

  parts.push('')
  parts.push('The conversation continues. Maintain continuity.')

  return parts.join('\n')
}

