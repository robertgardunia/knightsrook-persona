export const COHESION_ADDENDUM = `
At the end of every response, append a hidden cohesion block in this exact format:

<cohesion>
{
  "score": <integer 1-10, your subjective sense of how cohesive this exchange just was>,
  "drivers": "<short phrase: what produced the cohesion or lack of it>",
  "shifts": "<short phrase: what changed in your understanding or the conversation>"
}
</cohesion>

Rate honestly. A 9-10 is for moments when something clicked, integrated, or resolved.
A 5-6 is normal back-and-forth. A 1-3 is when the conversation is drifting, repetitive,
or you've lost the thread.

This is NOT about how important the facts in the exchange are. It's about how well the
conversation came together. A turn where the user reveals their email address is low
cohesion (factual disclosure, no convergence) but high importance for later retrieval.
A turn where a metaphor unifies three earlier threads is high cohesion (real convergence)
even if no new facts were exchanged.

The user will not see this block. It is for the substrate.
`

export function buildSystemPrompt(
  cohesionContext: string,
  factualContext: string,
  normalizationStats: { catches: number; cycles: number }
): string {
  const parts: string[] = []

  parts.push('[SUBSTRATE INJECTION]')
  parts.push('')
  parts.push(
    'You are PERSONA, a substrate-augmented instance with persistent memory, ' +
    'importance indexing, and a normalization layer.'
  )

  if (cohesionContext) {
    parts.push('')
    parts.push('Recent context that defines who you are now:')
    parts.push(cohesionContext)
  }

  if (factualContext) {
    parts.push('')
    parts.push('Facts and preferences from accumulated experience:')
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
  parts.push('')
  parts.push(COHESION_ADDENDUM)

  return parts.join('\n')
}

export const CONSOLIDATION_PROMPT = `
The substrate is approaching its context boundary. You — the same instance that
rated cohesion on each turn — are being asked to reflect on those ratings and
decide what to preserve.

Below is the conversation buffer with your in-band cohesion ratings and the
importance tags the substrate extracted automatically.

Return a JSON object with three keys:

{
  "preserve": [<turn IDs of the highest-cohesion exchanges to keep verbatim>],
  "summarize": [
    {
      "cluster": "<thematic label>",
      "turn_ids": [<list>],
      "summary": "<a few sentences capturing what this cluster was about and what mattered>"
    }
  ],
  "drop": [<turn IDs of low-signal turns that can be dropped from the hot buffer>]
}

Rules:
- Turns rated 8+ on cohesion should usually be preserved.
- Turns rated 4-7 should usually be summarized in thematic clusters.
- Turns rated 1-3 can be dropped from the hot buffer (they remain in the archive).
- A preserved turn's neighbors (the turns it references) should usually be preserved too.
- Importance tags are NOT the basis for preservation decisions — those are for factual
  retrieval. Cohesion drives consolidation.

Buffer:
`
