import { useState, useEffect } from 'react'
import { Collapsible as Fold } from '@base-ui/react/collapsible'
import { Plus, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Collapsible, CopyButton, Panel, Select } from './ui'
import type { Extension } from '../api'
const tones: Record<string, string> = {
  pending_approval: 'amber',
  executing: 'sky',
  succeeded: 'emerald',
  manual_review: 'amber',
  rejected: 'rose',
  revoked: 'neutral',
}
type ChangeView = {
  id: string
  status: string
  app: string
  extension_id?: string
  extension_version?: string
  requester_id: string
  beneficiary_principal: string
  role: string
  payload_hash: string
  evidence_ids: string[]
  expires_at: string | null
  revoked_at: string | null
  reason: string
}
export function Changes({
  user,
  api,
  report,
  onCount,
  revision,
  actionMeta,
}: {
  actionMeta: Extension[]
  revision: number
  onCount: (count: number) => void
  user: string
  api: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Response>
  report: (e: unknown) => void
}) {
  const [rows, setRows] = useState<ChangeView[]>([]),
    [reason, setReason] = useState(''),
    [ttl, setTtl] = useState(''),
    [notes, setNotes] = useState<Record<string, string>>({})
  const [choice, setChoice] = useState('')
  const actions = actionMeta
    .filter((e) => e.enabled)
    .flatMap((e) => e.uiManifest.actions.filter((a) => a.standalone))
  const key = (a: { app: string; role: string }) =>
    JSON.stringify([a.app, a.role])
  const selected = actions.find((a) => key(a) === choice) ?? actions[0]
  const pending = rows.filter((c) => c.status === 'pending_approval').length
  useEffect(() => onCount(pending), [pending, onCount])
  async function refresh(signal?: AbortSignal) {
    setRows(await (await api('changes', undefined, signal)).json())
  }
  useEffect(() => {
    const ctl = new AbortController()
    const load = () => void refresh(ctl.signal).catch(report)
    load()
    return () => {
      ctl.abort()
    }
  }, [user, revision])
  async function act(path: string, body: unknown) {
    try {
      await api(path, body)
      toast.success(path === 'changes' ? '已提交申请' : '变更已更新')
      await refresh()
    } catch (e) {
      toast.error(String(e))
      report(e)
    }
  }
  return (
    <div className="inspector-inner">
      <Fold.Root>
        <header className="bar">
          <ShieldCheck size={15} />
          <h2>权限变更与审计</h2>
          <Badge>{pending} 待处理</Badge>
          <span className="spacer" />
          <Fold.Trigger className="apply-trigger">
            <Plus size={12} />
            申请权限
          </Fold.Trigger>
        </header>
        <Fold.Panel className="fold-panel">
          <div className="change-list">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!selected) return
                void act('changes', {
                  app: selected.app,
                  role: selected.role,
                  reason,
                  ...(ttl && { ttl_minutes: Number(ttl) }),
                })
              }}
            >
              {selected ? (
                <Select
                  label="申请动作"
                  value={key(selected)}
                  onChange={setChoice}
                  options={actions.map((a) => ({
                    value: key(a),
                    label: a.title + ' · ' + a.app + ' / ' + a.role,
                  }))}
                />
              ) : (
                <p>当前没有已启用且支持手动申请的动作。</p>
              )}
              <label>
                申请理由
                <input
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label>
                有效期
                <Select
                  label="有效期"
                  value={ttl}
                  onChange={setTtl}
                  options={[
                    { value: '', label: '长期' },
                    { value: '1', label: '1 分钟 · 演示回收' },
                    { value: '30', label: '30 分钟' },
                  ]}
                />
              </label>
              <Button disabled={!selected} type="submit" variant="primary">
                提交申请
              </Button>
            </form>
          </div>
        </Fold.Panel>
      </Fold.Root>
      <div className="change-list">
        {!rows.length && <p className="empty">暂无权限变更</p>}
        {rows.toReversed().map((c) => (
          <Panel key={c.id}>
            <strong>
              {actionMeta
                .find(
                  (e) =>
                    e.id === c.extension_id &&
                    e.version === c.extension_version,
                )
                ?.uiManifest.actions.find((a) => key(a) === key(c))?.title ??
                c.app}
              {c.extension_id && (
                <Badge>
                  {c.extension_id}@{c.extension_version}
                </Badge>
              )}
              {c.beneficiary_principal} <code>{c.role}</code>
            </strong>
            <p>{c.reason}</p>
            <Badge tone={tones[c.status]}>
              <i className={c.status === 'executing' ? 'dot running' : 'dot'} />
              {c.status}
            </Badge>
            {!c.expires_at && <small className="stamp">长期有效</small>}
            {c.expires_at && (
              <p className="stamp">
                到期 · {new Date(c.expires_at).toLocaleString()}
              </p>
            )}
            {c.revoked_at && (
              <p className="stamp">
                已回收 · {new Date(c.revoked_at).toLocaleString()}
              </p>
            )}
            <Collapsible
              title="哈希 / 证据"
              action={<CopyButton value={c.payload_hash} />}
            >
              <code style={{ overflowWrap: 'anywhere' }}>{c.payload_hash}</code>
              <ul>
                {c.evidence_ids.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </Collapsible>
            <Audit change={c} api={api} report={report} />
            {user === 'carol' && c.status === 'manual_review' && (
              <label>
                人工核对依据
                <input
                  value={notes[c.id] ?? ''}
                  onChange={(e) =>
                    setNotes({ ...notes, [c.id]: e.target.value })
                  }
                />
              </label>
            )}
            {user === 'carol' &&
              c.requester_id !== user &&
              c.beneficiary_principal !== user &&
              (c.status === 'pending_approval'
                ? ['approve', 'reject']
                : c.status === 'manual_review'
                  ? ['succeeded', 'failed']
                  : []
              ).map((d) => (
                <Button
                  variant="outline"
                  disabled={
                    c.status === 'manual_review' && !notes[c.id]?.trim()
                  }
                  key={d}
                  onClick={() => {
                    const manual = c.status === 'manual_review'
                    const note = manual ? notes[c.id] : ''
                    if (manual && !note?.trim()) return
                    void act(
                      'changes/' +
                        c.id +
                        '/' +
                        (manual ? 'resolve' : 'decision'),
                      {
                        decision: d,
                        note,
                        payload_hash: c.payload_hash,
                      },
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
                </Button>
              ))}
          </Panel>
        ))}
      </div>
    </div>
  )
}

function Audit({
  change,
  api,
  report,
}: {
  change: ChangeView
  api: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Response>
  report: (e: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<
    {
      id: string
      actor_id: string
      note: string
      action: string
      created_at: string
    }[]
  >([])
  useEffect(() => {
    if (!open) return
    const ctl = new AbortController()
    api('changes/' + change.id + '/audit', undefined, ctl.signal)
      .then((r) => r.json())
      .then(setEvents)
      .catch(report)
    return () => ctl.abort()
  }, [open, change.id, change.status])
  return (
    <Collapsible title="审计轨迹" onOpenChange={setOpen}>
      {events.length ? (
        <ol>
          {events.map((e) => (
            <li key={e.id}>
              <b>{e.action}</b> · {e.actor_id}
              <small>{new Date(e.created_at).toLocaleString()}</small>
              {e.note}
            </li>
          ))}
        </ol>
      ) : (
        <small>暂无记录</small>
      )}
    </Collapsible>
  )
}
