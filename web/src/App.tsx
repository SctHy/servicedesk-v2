import { useResizableWidth } from './hooks/useResizableWidth'
import { ScrollArea } from '@base-ui/react/scroll-area'
import { Observation, type Entry } from './components/Observation'
import { useState, useEffect, useRef } from 'react'
import { client } from './api'
import { Changes } from './components/Changes'
import {
  ArrowUp,
  FolderKey,
  LoaderCircle,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Search,
  UserRound,
  SquarePen,
  ScanLine,
  Sun,
} from 'lucide-react'
import { Toaster, toast } from 'sonner'
import {
  Badge,
  Button,
  IconButton,
  Select,
  Switch,
  TooltipProvider,
} from './components/ui'

type Ticket = { id: string; scenario: string }
function Desk({
  user,
  setUser,
}: {
  user: string
  setUser: (user: string) => void
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]),
    [id, setId] = useState(''),
    [scenario, setScenario] = useState('A')
  const [message, setMessage] = useState(''),
    [entries, setEntries] = useState<Entry[]>([]),
    [busy, setBusy] = useState(false),
    [investigating, setInvestigating] = useState(false),
    [error, setError] = useState('')
  const [cases, setCases] = useState<{ id: string; title: string }[]>([])
  const current = useRef<AbortController | null>(null)
  const api = client(user)
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
        let terminal = false
        let successful = false
        let buffer = ''
        for (;;) {
          const part = await reader.read()
          signal.throwIfAborted()
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
              if (event.type === 'final') successful = true
              terminal ||= event.type === 'final' || event.type === 'error'
              setEntries((prev) =>
                event.evidenceId &&
                prev.some((e) => e.evidenceId === event.evidenceId)
                  ? prev
                  : [...prev, event],
              )
            }
          }
        }
        if (!terminal) throw Error('事件流提前结束')
        return successful
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
    setInvestigating(false)
    setBusy(!!ticket)
    setError('')
    try {
      if (ticket) {
        const detail = await (
          await api('tickets/' + ticket, undefined, ctl.signal)
        ).json()
        for (const run of detail.runs) {
          ctl.signal.throwIfAborted()
          await subscribe(run.id, ctl.signal)
        }
      }
    } catch (e) {
      report(e)
    } finally {
      if (!ctl.signal.aborted) {
        setBusy(false)
        setInvestigating(false)
      }
    }
  }
  async function submit() {
    const ctl = new AbortController()
    current.current = ctl
    setInvestigating(true)
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
      if (await subscribe(runId, ctl.signal)) {
        localStorage.setItem(
          'desk-completed-' + user + '-' + ticket,
          new Date().toISOString(),
        )
      }
    } catch (e) {
      report(e)
    } finally {
      if (!ctl.signal.aborted) {
        setBusy(false)
        setInvestigating(false)
      }
    }
  }
  const [session, setSession] = useState('normal')
  const [stale, setStale] = useState<Record<string, boolean>>({})
  const [demo, setDemo] = useState(false)
  useEffect(() => {
    if (!id) return
    const ctl = new AbortController()
    async function refresh() {
      try {
        const detail = await (
          await api('tickets/' + id, undefined, ctl.signal)
        ).json()
        if (ctl.signal.aborted) return
        setSession(detail.session)
        setDemo(detail.demo)
        setStale(
          Object.fromEntries(
            detail.evidence.map((e: { id: string; stale: boolean }) => [
              e.id,
              e.stale,
            ]),
          ),
        )
      } catch (e) {
        report(e)
      }
    }
    void refresh()
    const timer = setInterval(refresh, 1500)
    return () => {
      ctl.abort()
      clearInterval(timer)
    }
  }, [id])
  const selected = tickets.find((t) => t.id === id)
  const [query, setQuery] = useState('')
  function completionTime(ticket: string) {
    const date = localStorage.getItem('desk-completed-' + user + '-' + ticket)
    return date ? (
      <time dateTime={date} title={new Date(date).toLocaleString()}>
        {new Date(date).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </time>
    ) : null
  }
  const caseTitle = (ticket: Ticket) =>
    cases.find((c) => c.id === ticket.scenario)?.title ?? '工单'
  const matches = tickets.filter((t) =>
    (t.id + ' 案例 ' + t.scenario + ' ' + caseTitle(t))
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const evidence = entries.filter((e) => e.evidenceId)
  const historical = (e: Entry) =>
    Boolean(
      e.evidenceId &&
      (stale[e.evidenceId] ||
        evidence.some(
          (x) =>
            x.source === e.source &&
            (x.observedAt ?? '') > (e.observedAt ?? ''),
        )),
    )
  const historyCount = evidence.filter(historical).length
  const groups: Entry[][] = []
  let summary: string | undefined
  for (const entry of entries) {
    if (entry.type === 'started') continue
    if (entry.type === 'question') summary = undefined
    if (entry.type === 'model') {
      summary = entry.summary
      continue
    }
    const previous = groups.at(-1)
    if (entry.evidenceId && previous?.[0]?.evidenceId) previous.push(entry)
    else groups.push([entry.type === 'final' ? { ...entry, summary } : entry])
  }
  const [fault, setFault] = useState('none')
  const [savingFault, setSavingFault] = useState(false)
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    const ctl = new AbortController()
    client(user)('demo/fault', undefined, ctl.signal)
      .then((r) => r.json())
      .then((d) => {
        setFault(d.fault)
        setAvailable(true)
      })
      .catch(() => setAvailable(false))
    return () => ctl.abort()
  }, [user])
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 760)
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1200)
  const left = useResizableWidth('left', 256, 200, 420)
  const right = useResizableWidth('right', 288, 240, 520)
  const [pending, setPending] = useState(0)
  const [dark, setDark] = useState(
    () => localStorage.getItem('desk-theme') !== 'light',
  )
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('desk-theme', dark ? 'dark' : 'light')
  }, [dark])
  useEffect(() => {
    if (scroll.current && follow.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [entries])
  const canSend = !busy && (!id || !!message.trim())
  const roles: Record<string, string> = {
    alice: '申请人',
    bob: '申请人',
    carol: '审批人',
    guest: '跨租户',
  }
  const title = cases.find((c) => c.id === selected?.scenario)?.title
  function openTicket(ticket: string) {
    follow.current = true
    setMessage('')
    void select(ticket)
    if (window.innerWidth < 760) setSidebar(false)
  }
  return (
    <TooltipProvider>
      <Toaster theme={dark ? 'dark' : 'light'} />
      <main
        className="shell"
        style={
          {
            '--details-space': inspector ? right.width + 24 + 'px' : '0px',
          } as React.CSSProperties
        }
        data-resizing={left.dragging || right.dragging || undefined}
      >
        <aside
          data-slot="sidebar"
          className="sidebar"
          inert={!sidebar}
          style={{ width: sidebar ? left.width : 0 }}
        >
          <div {...left.handle} />
          <div className="sidebar-inner">
            <header className="bar">
              <b className="logo">SD</b>
              <strong>ServiceDesk</strong>
            </header>
            <div className="threads">
              <div className="search-row">
                <Search size={15} />
                <input
                  aria-label="搜索工单"
                  placeholder="搜索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <IconButton label="收起侧栏" onClick={() => setSidebar(false)}>
                  <PanelLeftClose />
                </IconButton>
                <IconButton label="新建工单" onClick={() => openTicket('')}>
                  <SquarePen />
                </IconButton>
              </div>
              <nav>
                {matches.map((t) => (
                  <Button
                    data-thread-item
                    key={t.id}
                    aria-current={id === t.id ? 'page' : undefined}
                    onClick={() => openTicket(t.id)}
                  >
                    <span className="thread-top">
                      <b className="project-icon">SD</b> ServiceDesk v2
                      <small>
                        {id === t.id && investigating ? (
                          <span className="running">● 取证中</span>
                        ) : (
                          completionTime(t.id)
                        )}
                      </small>
                    </span>
                    <span className="thread-title">{caseTitle(t)}</span>
                    <small>
                      案例 {t.scenario} · <code>{t.id.slice(0, 8)}</code>
                    </small>
                  </Button>
                ))}
              </nav>
            </div>
            <footer>
              <UserRound size={15} />
              <Select
                label="演示账号"
                value={user}
                onChange={setUser}
                options={Object.keys(roles).map((value) => ({
                  value,
                  label: value,
                }))}
              />
              <Badge>{roles[user]}</Badge>
              <IconButton label="新建调查" onClick={() => openTicket('')}>
                <SquarePen />
              </IconButton>
            </footer>
          </div>
        </aside>
        <section className="conversation" data-workspace-area="conversation">
          <header className="bar" data-chat-header>
            {!sidebar && (
              <IconButton label="展开侧栏" onClick={() => setSidebar(true)}>
                <PanelLeftOpen />
              </IconButton>
            )}
            <b className="project-icon">SD</b>
            <span className="project-name">ServiceDesk v2</span>
            <span className="slash">/</span>
            <h1>{title || '新工单'}</h1>
            <span className="spacer" />
            <IconButton label="切换主题" onClick={() => setDark(!dark)}>
              {dark ? <Sun /> : <Moon />}
            </IconButton>
            <IconButton
              label="权限变更与审计"
              aria-expanded={inspector}
              onClick={() => setInspector(!inspector)}
            >
              <PanelRight />
              {pending > 0 && <span className="count">{pending}</span>}
            </IconButton>
          </header>
          <ScrollArea.Root className="timeline-area">
            <ScrollArea.Viewport
              className="messages-timeline-scroll"
              ref={scroll}
              onScroll={(e) => {
                const el = e.currentTarget
                follow.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 72
              }}
            >
              <ScrollArea.Content className="timeline-content">
                {!id && !entries.length ? (
                  <div className="welcome">
                    <div className="hero-icon">
                      <ScanLine />
                    </div>
                    <h2>开始工单调查</h2>
                    <div className="scenarios">
                      {cases.map((c) => (
                        <Button
                          variant="outline"
                          key={c.id}
                          onClick={() => {
                            setScenario(c.id)
                            setMessage(c.title)
                          }}
                        >
                          {c.id === 'A' ? <Monitor /> : <FolderKey />}
                          <span>
                            <small>案例 {c.id}</small>
                            {c.title}
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="timeline">
                    {groups.map((group, i) =>
                      group[0].evidenceId ? (
                        <section
                          className="evidence-group"
                          key={group[0].evidenceId}
                        >
                          <h3>
                            {group.length} 条只读取证 ·{' '}
                            {group.some(historical)
                              ? group.filter(historical).length + ' 条历史'
                              : '全部最新'}
                          </h3>
                          {group.map((e) => (
                            <Observation
                              key={e.evidenceId}
                              e={e}
                              historical={historical(e)}
                            />
                          ))}
                        </section>
                      ) : (
                        <Observation key={i} e={group[0]} historical={false} />
                      ),
                    )}
                    {investigating && (
                      <div className="event">
                        <LoaderCircle size={14} className="animate-spin" />
                        正在取证…
                      </div>
                    )}
                  </div>
                )}
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar className="scrollbar">
              <ScrollArea.Thumb className="thumb" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
          <div className="composer-wrap">
            {error && <p role="alert">{error}</p>}
            <form
              data-slot="composer-host"
              className="composer"
              onSubmit={(e) => {
                e.preventDefault()
                if (canSend) {
                  follow.current = true
                  void submit()
                }
              }}
            >
              <textarea
                aria-label="调查问题"
                rows={2}
                placeholder={id ? '继续追问…' : '描述遇到的问题…'}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.nativeEvent.keyCode !== 229
                  ) {
                    e.preventDefault()
                    e.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              <div className="toolbar">
                {id ? (
                  <small>案例 {selected?.scenario}</small>
                ) : (
                  <Select
                    label="选择案例"
                    value={scenario}
                    options={cases.map((c) => ({
                      value: c.id,
                      label: '案例 ' + c.id,
                    }))}
                    onChange={setScenario}
                  />
                )}
                <span className="spacer" />
                <small>
                  <i className={'dot ' + (busy ? 'running' : '')} />
                  {busy ? '正在取证' : '就绪'}
                </small>
                <IconButton
                  type="submit"
                  variant="primary"
                  disabled={!canSend}
                  label={id ? '发送追问' : '创建并调查'}
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <ArrowUp />
                  )}
                </IconButton>
              </div>
            </form>
          </div>
        </section>
        <aside
          data-thread-details-card
          className="inspector"
          hidden={!inspector}
          style={{ width: right.width }}
        >
          <div {...right.handle} />
          <div className="details-scroll">
            <Changes
              user={user}
              api={api}
              report={report}
              onCount={setPending}
            />
            <section className="details-section">
              <h3>运行环境</h3>
              {demo && selected?.scenario === 'B' && (
                <div className="control">
                  <span>桌面会话</span>
                  <Select
                    label="桌面会话"
                    value={session}
                    disabled={busy}
                    options={[
                      { value: 'normal', label: '正常项目账号' },
                      { value: 'wrong_account', label: '模拟登错 403' },
                    ]}
                    onChange={async (value) => {
                      const ticketSignal = current.current?.signal
                      try {
                        await api(
                          'demo/tickets/' + id + '/session',
                          { session: value },
                          ticketSignal,
                        )
                        if (!ticketSignal?.aborted) setSession(String(value))
                      } catch (e) {
                        report(e)
                      }
                    }}
                  />
                </div>
              )}
              {available && (
                <div className="control fault">
                  <span>外部权限 503</span>
                  <Switch
                    label="外部权限 503"
                    disabled={user === 'guest' || savingFault}
                    checked={fault !== 'none'}
                    onChange={async (on) => {
                      setSavingFault(true)
                      try {
                        const value = on ? 'unknown_external_state' : 'none'
                        await api('demo/fault', { fault: value })
                        setFault(value)
                        toast.success(
                          on ? '已启用模拟 503' : '已恢复正常权限服务',
                        )
                      } catch (e) {
                        toast.error(String(e))
                      } finally {
                        setSavingFault(false)
                      }
                    }}
                  />
                </div>
              )}
              {!available && <small>环境控制不可用</small>}
            </section>
            <section className="details-section">
              <h3>工单上下文</h3>
              <div className="control">
                <span>证据 {evidence.length} 条</span>
                <span>
                  {evidence.length - historyCount} 最新 · {historyCount} 历史
                </span>
              </div>
              <div className="control">
                <span>运行模式</span>
                <span>
                  {!id ? '未选择工单' : demo ? '演示模式' : '标准模式'}
                </span>
              </div>
            </section>
          </div>
        </aside>
      </main>
    </TooltipProvider>
  )
}
export default function App() {
  const [user, setUser] = useState('alice')
  return <Desk key={user} user={user} setUser={setUser} />
}
