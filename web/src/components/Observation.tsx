import {
  Activity,
  BookOpen,
  UserCheck,
  ShieldCheck,
  Monitor,
  ScanLine,
  Search,
  Sparkles,
} from 'lucide-react'
import { Badge, Collapsible, CopyButton } from './ui'

import type { ObservationMeta } from '../api'

export type Entry = {
  detail?: string
  status?: string
  type: string
  evidenceId?: string
  observedAt?: string
  source?: string
  data?: Record<string, unknown>
  text?: string
  summary?: string
}
export function Observation({
  e,
  historical,
  observationMeta,
}: {
  e: Entry
  observationMeta?: Record<string, ObservationMeta>
  historical: boolean
}) {
  if (e.evidenceId) {
    const meta = observationMeta?.[e.source ?? '']
    const data = e.data && typeof e.data === 'object' ? e.data : { value: e.data } as Record<string, unknown>
    const fields = Array.isArray(meta?.summaryFields)
      ? meta.summaryFields
      : Object.keys(data).slice(0, 4)
    const icons = {
      get_login_sessions: Monitor,
      get_directory_profile: UserCheck,
      get_app_permissions: ShieldCheck,
      get_service_events: Activity,
      search_runbooks: BookOpen,
    }
    const Icon = Object.hasOwn(icons, e.source ?? '')
      ? icons[e.source as keyof typeof icons]
      : Search
    return (
      <article className="entry work" data-timeline-row-kind="work">
        <Collapsible
          action={<CopyButton value={e.evidenceId} short />}
          title={
            <>
              <Icon size={14} />
              <span className="tool-info" title={e.source}>
                <code>
                  {typeof meta?.title === 'string' ? meta.title : e.source}
                </code>
                <Badge tone={historical ? 'neutral' : 'sky'}>
                  {historical ? '历史' : '最新'}
                </Badge>
                {['samePrincipal', 'sameMailbox']
                  .filter((k) => Object.hasOwn(data, k))
                  .map((k) => (
                    <Badge
                      key={k}
                      tone={e.data?.[k] === true ? 'emerald' : 'amber'}
                    >
                      {k} {String(e.data?.[k])}
                    </Badge>
                  ))}
              </span>
              <time title={e.observedAt}>
                {e.observedAt && new Date(e.observedAt).toLocaleTimeString()}
              </time>
            </>
          }
        >
          <pre aria-label="原始观测 JSON">
            {JSON.stringify(e.data, null, 2)}
          </pre>
        </Collapsible>
        <dl>
          {fields
            .filter((k) => Object.hasOwn(data, k))
            .map((k) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  {(typeof data[k] === 'string'
                    ? data[k]
                    : JSON.stringify(data[k])
                  )?.slice(0, 160)}
                </dd>
              </div>
            ))}
        </dl>
      </article>
    )
  }
  if (e.type === 'question')
    return (
      <p className="entry bubble" data-user-message-bubble>
        {e.text}
      </p>
    )
  if (e.type === 'final')
    return (
      <article className="entry chat-markdown">
        <h3>
          <Sparkles size={16} />
          调查结论
        </h3>
        <p>
          {e.text
            ?.split(/(\[[^\]\n]+\])/g)
            .map((s, i) =>
              s.startsWith('[') ? (
                <CopyButton key={i} value={s.slice(1, -1)} citation />
              ) : (
                s
              ),
            )}
        </p>
        {e.summary && (
          <Collapsible title="模型出站脱敏摘要">
            <pre>{e.summary}</pre>
          </Collapsible>
        )}
      </article>
    )
  return (
    <div className="entry event">
      <ScanLine size={14} />
      {e.text ||
        { started: '开始调查', draft: '已起草变更', error: '调查中断' }[e.type]}
    </div>
  )
}
