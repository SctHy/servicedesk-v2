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
