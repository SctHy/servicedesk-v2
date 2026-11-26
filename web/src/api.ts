export const client =
  (user: string) =>
  async (
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    cursor?: number,
  ) => {
    const r = await fetch('/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'x-demo-user': user,
        ...(cursor ? { 'Last-Event-ID': String(cursor) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    if (!r.ok) throw Error('请求失败 ' + r.status)
    return r
  }

export async function tenantEvents(
  user: string,
  signal: AbortSignal,
  refresh: (type: string) => void,
) {
  while (!signal.aborted) {
    try {
      const response = await client(user)('events', undefined, signal)
      const reader = response
        .body!.pipeThrough(new TextDecoderStream())
        .getReader()
      refresh('all')
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (frame.startsWith('data: '))
            refresh(JSON.parse(frame.slice(6)).type)
        }
      }
    } catch {
      if (signal.aborted) return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export type ObservationMeta = { title: string; summaryFields?: string[] }
export type ActionMeta = {
  id: string
  app: string
  role: string
  title: string
  standalone: boolean
}
export type Extension = {
  id: string
  version: string
  title: string
  enabled: boolean
  activeRefs: number
  scenarios: { id: string; title: string }[]
  uiManifest: {
    observationMeta: Record<string, ObservationMeta>
    actions: ActionMeta[]
    demoControls?: Record<string, string[]>
  }
}
type Api = ReturnType<typeof client>
export type Metrics = {
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  runs_total: number
  runs_failed: number
  tokens_total: number
  tool_attempts: number
  tool_failures: number
  jobs_succeeded: number
  jobs_revoked: number
  jobs_manual_review: number
}
export async function extensions(
  api: Api,
  signal?: AbortSignal,
): Promise<Extension[]> {
  return (await api('extensions', undefined, signal)).json()
}
export async function metrics(
  api: Api,
  signal?: AbortSignal,
): Promise<Metrics> {
  return (await api('metrics', undefined, signal)).json()
}
export async function toggle(
  api: Api,
  id: string,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  return (
    await api('extensions/' + encodeURIComponent(id) + '/toggle', { enabled })
  ).json()
}
export async function startRun(
  api: Api,
  ticket: string,
  message: string,
  signal: AbortSignal,
  resume_from?: string,
): Promise<{ runId: string }> {
  return (
    await api(
      'tickets/' + ticket + '/runs',
      { message, client_request_id: crypto.randomUUID(), resume_from },
      signal,
    )
  ).json()
}
export async function steer(
  api: Api,
  run: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ runId: string }> {
  return (await api('runs/' + run + '/steer', { message }, signal)).json()
}
