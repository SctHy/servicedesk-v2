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
