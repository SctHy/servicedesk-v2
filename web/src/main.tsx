import React, { useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
type Ticket = { id: string; scenario: string }
type Entry = {
  type: string
  evidenceId?: string
  observedAt?: string
  source?: string
  data?: Record<string, unknown>
  text?: string
  summary?: string
}
function Desk({ user }: { user: string }) {
  const [tickets, setTickets] = useState<Ticket[]>([]),
    [id, setId] = useState(''),
    [scenario, setScenario] = useState('A')
  const [message, setMessage] = useState(''),
    [entries, setEntries] = useState<Entry[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [cases, setCases] = useState<{ id: string; title: string }[]>([])
  const current = useRef<AbortController | null>(null)
  async function api(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    cursor?: number,
  ) {
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
  function report(e: unknown) {
    if (!(e instanceof DOMException && e.name === 'AbortError'))
      setError(String(e))
  }
  useEffect(() => {
    const ctl = new AbortController()
    Promise.all([
      api('tickets', undefined, ctl.signal)
        .then((r) => r.json())
        .then(setTickets),
      api('demo/scenarios', undefined, ctl.signal)
        .then((r) => r.json())
        .then(setCases),
    ]).catch(report)
    return () => {
      ctl.abort()
      current.current?.abort()
    }
  }, [])
  async function subscribe(run: string, signal: AbortSignal) {
    let cursor = 0
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api(
            'runs/' + run + '/events',
            undefined,
            signal,
            cursor,
          ),
          reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          buffer += part.value
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const bufferId = buffer.slice(0, end).match(/^id: (\d+)/)?.[1]
            const line = buffer
              .slice(0, end)
              .split('\n')
              .find((s) => s.startsWith('data: '))
            buffer = buffer.slice(end + 2)
            if (line) {
              cursor = Number(bufferId)
              const event = JSON.parse(line.slice(6))
              setEntries((prev) =>
                event.evidenceId &&
                prev.some((e) => e.evidenceId === event.evidenceId)
                  ? prev
                  : [...prev, event],
              )
            }
          }
        }
        return
      } catch (e) {
        if (signal.aborted || attempt >= 2) throw e
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
  }
  async function select(ticket: string) {
    current.current?.abort()
    const ctl = new AbortController()
    current.current = ctl
    setId(ticket)
    setEntries([])
    setBusy(!!ticket)
    setError('')
    try {
      if (ticket) {
        const detail = await (
          await api('tickets/' + ticket, undefined, ctl.signal)
        ).json()
        setEntries(
          detail.evidence.map(
            (e: {
              id: string
              source: string
              observed_at: string
              data: object
            }) => ({
              type: 'evidence',
              evidenceId: e.id,
              source: e.source,
              observedAt: e.observed_at,
              data: e.data,
            }),
          ),
        )
        if (detail.runs.length)
          await subscribe(detail.runs.at(-1).id, ctl.signal)
      }
    } catch (e) {
      report(e)
    } finally {
      if (!ctl.signal.aborted) setBusy(false)
    }
  }
  async function submit() {
    const ctl = new AbortController()
    current.current = ctl
    setBusy(true)
    setError('')
    try {
      let ticket = id
      if (!ticket) {
        const t = await (await api('tickets', { scenario }, ctl.signal)).json()
        ticket = t.id
        setId(ticket)
        setTickets((prev) => [t, ...prev])
      }
      const question =
        message.trim() ||
        cases.find((c) => c.id === scenario)?.title ||
        '调查 403'
      const { runId } = await (
        await api(
          'tickets/' + ticket + '/runs',
          { message: question, client_request_id: crypto.randomUUID() },
          ctl.signal,
        )
      ).json()
      setMessage('')
      await subscribe(runId, ctl.signal)
    } catch (e) {
      report(e)
    } finally {
      if (!ctl.signal.aborted) setBusy(false)
    }
  }
  const summary = entries.findLast((e) => e.type === 'model')?.summary
  return (
    <main>
      <aside>
        <Changes user={user} api={api} report={report} />
        <h2>工单</h2>
        <button onClick={() => select('')}>＋ 新建工单</button>
        {tickets.map((t) => (
          <button
            className={id === t.id ? 'active' : ''}
            key={t.id}
            onClick={() => select(t.id)}
          >
            案例 {t.scenario} · {t.id.slice(0, 8)}
          </button>
        ))}
      </aside>
      <section>
        <h1>调查工作台</h1>
        {!id && (
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <textarea
            aria-label="调查问题"
            placeholder={id ? '继续追问…' : '描述遇到的问题…'}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button disabled={busy || (!!id && !message.trim())}>
            {busy ? '取证中…' : id ? '发送追问' : '创建并调查'}
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {entries
          .filter((e) => e.type !== 'model')
          .map((e, i) => (
            <article key={i}>
              <strong>
                {e.source ||
                  {
                    question: '调查问题',
                    started: '开始调查',
                    final: '调查结论',
                    error: '调查中断',
                  }[e.type]}
              </strong>
              <p>{e.text}</p>
              {e.evidenceId && (
                <>
                  <small>
                    {e.observedAt} · {e.evidenceId}
                  </small>
                  <div>
                    {['sameMailbox', 'samePrincipal']
                      .filter((k) => k in (e.data ?? {}))
                      .map((k) => (
                        <code key={k}>
                          {k} {String(e.data?.[k])}
                        </code>
                      ))}
                  </div>
                  <pre>{JSON.stringify(e.data, null, 2)}</pre>
                </>
              )}
            </article>
          ))}
        {summary && (
          <details>
            <summary>模型出站摘要</summary>
            <pre>{summary}</pre>
          </details>
        )}
      </section>
    </main>
  )
}
type ChangeView = {
  id: string
  status: string
  requester_id: string
  beneficiary_principal: string
  role: string
  payload_hash: string
  evidence_ids: string[]
  reason: string
}
function Changes({
  user,
  api,
  report,
}: {
  user: string
  api: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Response>
  report: (e: unknown) => void
}) {
  const [rows, setRows] = useState<ChangeView[]>([]),
    [reason, setReason] = useState('')
  async function refresh(signal?: AbortSignal) {
    setRows(await (await api('changes', undefined, signal)).json())
  }
  useEffect(() => {
    const ctl = new AbortController()
    const load = () => void refresh(ctl.signal).catch(report)
    load()
    const timer = setInterval(load, 1500)
    return () => {
      clearInterval(timer)
      ctl.abort()
    }
  }, [user])
  async function act(path: string, body: unknown) {
    try {
      await api(path, body)
      await refresh()
    } catch (e) {
      report(e)
    }
  }
  return (
    <div>
      <h2>权限申请与审批</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void act('changes', {
            app: 'project-b-app',
            role: 'project-b:viewer',
            reason,
          })
        }}
      >
        <label>
          项目 B 只读权限申请理由
          <input
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button>提交申请</button>
      </form>
      {rows.map((c) => (
        <article key={c.id}>
          <strong>
            {c.beneficiary_principal} · {c.role}
          </strong>
          <p>{c.reason}</p>
          <p>{c.status === 'succeeded' ? '已确认生效' : c.status}</p>
          <details>
            <summary>冻结哈希与证据</summary>
            <code style={{ overflowWrap: 'anywhere' }}>{c.payload_hash}</code>
            <ul>
              {c.evidence_ids.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </details>
          {user === 'carol' &&
            c.requester_id !== user &&
            c.beneficiary_principal !== user &&
            (c.status === 'pending_approval'
              ? ['approve', 'reject']
              : c.status === 'manual_review'
                ? ['succeeded', 'failed']
                : []
            ).map((d) => (
              <button
                key={d}
                onClick={() => {
                  const manual = c.status === 'manual_review'
                  const note = manual ? window.prompt('请输入人工核对依据') : ''
                  if (manual && !note?.trim()) return
                  void act(
                    'changes/' + c.id + '/' + (manual ? 'resolve' : 'decision'),
                    { decision: d, note, payload_hash: c.payload_hash },
                  )
                }}
              >
                {
                  {
                    approve: '批准',
                    reject: '拒绝',
                    succeeded: '核对已生效',
                    failed: '核对失败',
                  }[d]
                }
              </button>
            ))}
        </article>
      ))}
    </div>
  )
}
function App() {
  const [user, set] = useState('alice')
  return (
    <>
      <header>
        ServiceDesk{' '}
        <label>
          演示账号{' '}
          <select value={user} onChange={(e) => set(e.target.value)}>
            {['alice', 'bob', 'carol', 'guest'].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </header>
      <Desk key={user} user={user} />
    </>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
