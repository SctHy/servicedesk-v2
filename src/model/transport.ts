import { calculateCost, clampThinkingLevel, getEnvApiKey, getModel, getModels, getProviders,
  type Api, type Model, type Usage } from '@mariozechner/pi-ai'

export type ModelSettings = {
  reasoning?: ReturnType<typeof reasoningLevel>
  provider?: string
  baseUrl?: string
  id?: string
  apiKey?: string
}

export function environmentModelSettings(): ModelSettings {
  return {
    reasoning: reasoningLevel(process.env.MODEL_REASONING),
    provider: process.env.MODEL_PROVIDER,
    baseUrl: process.env.MODEL_BASE_URL,
    id: process.env.MODEL_ID,
    apiKey: process.env.MODEL_API_KEY,
  }
}

export function reasoningLevel(value?: string) {
  if (!value) return undefined
  if (
    value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high'
  )
    return value
  throw Error('Invalid reasoning level')
}

export function investigationModel(baseUrl?: string, id?: string, provider?: string): Model<Api> {
  const name = provider ?? 'openai'
  const defaultOpenAI = name === 'openai' && (!id || id === 'gpt-6.2-sol')
  if (!defaultOpenAI && (provider || !baseUrl)) {
    const builtin = getProviders().find(p => p === name)
    if (!builtin) throw Error('Unknown model provider: ' + name)
    const models = getModels(builtin)
    const match = id ? models.find(m => m.id === id) : models[0]
    if (match) return baseUrl ? { ...match, baseUrl } : match
    if (provider && !(name === 'deepseek' && baseUrl))
      throw Error('Unknown model for ' + name + ': ' + id)
  }
  const resolvedBaseUrl = baseUrl || 'https://api.openai.com/v1'
  const resolvedId = id || 'gpt-6.2-sol'
  if (
    new URL(resolvedBaseUrl).origin === 'https://api.openai.com' &&
    resolvedId === 'gpt-6.2-sol'
  ) {
    // Pi's default Responses effort is 'none'; this model requires at least 'low'.
    return {
      ...getModel('openai', 'o3'),
      id: resolvedId,
      name: resolvedId,
      baseUrl: resolvedBaseUrl,
      thinkingLevelMap: { off: 'low' as const },
    }
  }
  const base = getModel('openai', 'gpt-4o-mini')
  return {
    ...base,
    api: 'openai-completions' as const,
    ...(name === 'deepseek' || new URL(resolvedBaseUrl).hostname === 'api.deepseek.com'
      ? {
          provider: 'deepseek',
          reasoning: true,
          compat: {
            maxTokensField: 'max_tokens' as const,
            supportsStrictMode: false,
          },
        }
      : {}),
    id: resolvedId,
    baseUrl: resolvedBaseUrl,
  }
}

export function modelTransport(settings: ModelSettings) {
  const model = investigationModel(settings.baseUrl, settings.id, settings.provider)
  const requested = settings.reasoning ?? 'off'
  const level = model.id === 'gpt-6.2-sol' && requested === 'off' ? 'low' : requested
  return {
    model,
    thinkingLevel: clampThinkingLevel(model, level),
    apiKey: settings.apiKey ?? getEnvApiKey(model.provider),
  }
}

export function usageCounters() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
}

export function recordUsage(totals: ReturnType<typeof usageCounters>, model: Model<Api>, usage: Usage) {
  totals.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite
  totals.outputTokens += usage.output
  totals.totalTokens += usage.totalTokens
  totals.cacheReadTokens += usage.cacheRead
  totals.cacheWriteTokens += usage.cacheWrite
  totals.costUsd += usage.cost.total || calculateCost(model, { ...usage, cost: { ...usage.cost } }).total
}
