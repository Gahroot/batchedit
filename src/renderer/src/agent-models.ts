/**
 * Selectable agent LLMs. `provider`/`model` map straight onto the main-process
 * agent start options; `keyKind` selects which stored API key to send.
 *
 * - google  → custom Gemini provider (GOOGLE_PROVIDER) in src/main/agent
 * - xiaomi  → built-in OpenAI-compatible provider in @prestyj/ai, defaulting to
 *             the Xiaomi MiMo Token Plan endpoint (token-plan-sgp.xiaomimimo.com)
 */
export interface AgentModelOption {
  id: string
  label: string
  provider: 'google' | 'xiaomi'
  model: string
  keyKind: 'gemini' | 'xiaomi'
}

export const AGENT_MODELS: AgentModelOption[] = [
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'google',
    model: 'gemini-3.5-flash',
    keyKind: 'gemini'
  },
  {
    id: 'mimo-v2.5',
    label: 'Xiaomi MiMo-V2.5',
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    keyKind: 'xiaomi'
  }
]

export const DEFAULT_AGENT_MODEL_ID = 'gemini-3.5-flash'

export function getAgentModel(id: string): AgentModelOption {
  return AGENT_MODELS.find((m) => m.id === id) ?? AGENT_MODELS[0]
}
