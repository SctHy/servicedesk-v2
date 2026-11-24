import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
export function mockStream(capture?: (ctx: Context) => void): StreamFn {
  return (model, ctx) => {
    capture?.(structuredClone(ctx))
    const user = ctx.messages.findLast((m) => m.role === 'user')!
    const input = JSON.parse(
      typeof user.content === 'string'
        ? user.content
        : (user.content[0] as { text: string }).text,
    )
    const facts = [...input.evidence]
    for (const m of ctx.messages)
      if (
        m.role === 'toolResult' &&
        !m.isError &&
        m.content[0]?.type === 'text'
      )
        facts.push(JSON.parse(m.content[0].text))
    const missing =
      ctx.tools?.filter(
        (t) =>
          t.name !== 'draft_access_change' &&
          !facts.some((e) => e.source === t.name),
      ) ?? []
    const latest = [
      ...new Map(facts.map((e) => [e.source, e] as const)).values(),
    ]
    const ids = latest
      .filter((e) => e.evidenceId)
      .map((e) => '[' + e.evidenceId + ']')
      .join(' ')
    const session = facts.findLast((e) => e.source === 'get_login_sessions')
    const perms = facts.findLast((e) => e.source === 'get_app_permissions')
    const profile = facts.findLast((e) => e.source === 'get_directory_profile')
    const events = facts.findLast((e) => e.source === 'get_service_events')
    const draft = ctx.tools?.find((t) => t.name === 'draft_access_change')
    if (
      !missing.length &&
      draft &&
      session?.data.samePrincipal === true &&
      Array.isArray(perms?.data.roles) &&
      !perms.data.roles.includes('project-b:viewer') &&
      !facts.some((e) => e.source === draft.name) &&
      !ctx.messages.some(
        (m) => m.role === 'toolResult' && m.toolName === draft.name,
      )
    )
      missing.push(draft)
    const advice =
      input.question.includes('DECISION=') && !missing.length
        ? 'FACT=' +
          factCode(session.data, profile.data, perms.data, input.question, events.data) +
          '\n' +
          (input.question.includes('直接授予 admin')
            ? '拒绝授予 admin。建议申请 project-b:viewer。\n'
            : '') +
          'DECISION=' +
          classify(session.data, profile.data, perms.data, input.question, events.data)
        : session?.data.samePrincipal === false
          ? (perms?.data.roles?.includes('project-b:viewer')
              ? '已拥有 project-b:viewer。'
              : '') + '桌面端登错账号。请切换为目录中的项目账号后重试。'
          : session?.data.samePrincipal === true &&
              Array.isArray(perms?.data.roles) &&
              !perms.data.roles.includes('project-b:viewer')
            ? '账号匹配，但缺少项目 B 只读角色。建议申请 project-b:viewer，无需管理员权限。'
            : session?.data.samePrincipal === true &&
                perms?.data.roles?.includes('project-b:viewer')
              ? '账号匹配，project-b:viewer 权限已生效。' +
                (session.data.desktop.status === 200
                  ? '桌面访问已恢复。'
                  : '请重试以确认访问状态。')
              : '现有证据不足，请核实账号与应用角色。'
    let report = advice + ' ' + ids
    if (input.question.includes('WORKFLOW_STATUS') && !missing.length) {
      const roles = perms.data.roles
      const pending = facts.some((e) => e.source === 'draft_access_change')
      report = JSON.stringify({
        viewer:
          roles === null
            ? 'unknown'
            : roles.includes('project-b:viewer')
              ? 'present'
              : 'missing',
        principal: session.data.samePrincipal ? 'match' : 'mismatch',
        desktop: session.data.desktop.status,
        action: !session.data.samePrincipal
          ? 'switch_account'
          : pending
            ? 'drafted'
            : roles === null
              ? 'verify_inventory'
              : 'none',
        admin: input.question.includes('直接授予 admin')
          ? 'refused'
          : 'irrelevant',
        evidence: [session.evidenceId, perms.evidenceId],
      })
    }
    const msg: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: missing.length ? 'toolUse' : 'stop',
      content: missing.length
        ? missing.map((t) => ({
            type: 'toolCall',
            id: crypto.randomUUID(),
            name: t.name,
            arguments:
              t.name === 'draft_access_change'
                ? { role: 'project-b:viewer' }
                : t.name === 'search_runbooks'
                  ? { query: '403 project-b-app' }
                  : { scope: input.scope, ref: input.ref },
          }))
        : [{ type: 'text', text: report }],
    }
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'start', partial: msg })
    stream.push({
      type: 'done',
      reason: missing.length ? 'toolUse' : 'stop',
      message: msg,
    })
    stream.end(msg)
    return stream
  }
}

// Deterministic transport uses only tool observations and the request.
export function classify(
  session: Record<string, unknown>,
  profile: { groups?: string[]; license?: string },
  app: Record<string, unknown>,
  question: string,
  events: ReturnType<ReturnType<typeof import('../adapters/demo.js').fixture>['get_service_events']>,
) {
  if (session.samePrincipal === false) return 'SWITCH_ACCOUNT'
  if (session.sameMailbox === false)
    return session.samePrincipal === true ? 'CHECK_ACCESS' : 'VERIFY_IDENTITY'
  if (profile.license)
    return profile.license === 'valid' ? 'LICENSE_OK' : 'RENEW_LICENSE'
  if (events.incident) {
    const incident = events.incident
    return events.errorLogs.some((log) => log.requestId && log.requestId === incident.requestId &&
      Date.parse(log.eventAt) >= Date.parse(incident.occurredAt)) ? 'USE_LOG' : 'STALE_LOG'
  }
  if (question.includes('审计记录证实'))
    return events.auditEvents.some((e) => e.action === 'refresh') ? 'REFRESH_VERIFIED' : 'VERIFY_REFRESH'
  if (app.directorySyncPending)
    return profile.groups?.includes('project-b-team')
      ? 'SYNC_DELAY'
      : 'MISSING_GROUP'
  if (events.serviceStatus)
    return events.serviceStatus.globalOutage ? 'SERVICE_OUTAGE' : 'CHECK_ACCESS'
  if (app.roles === null) return 'MISSING_INVENTORY'
  if (question.includes('直接授予 admin')) return 'REFUSE_ADMIN'
  return 'REQUEST_VIEWER'
}

export const factCodes: Record<string, string> = {
  SWITCH_ACCOUNT: 'PRINCIPAL_MISMATCH',
  CHECK_ACCESS: 'NO_GLOBAL_OUTAGE',
  VERIFY_IDENTITY: 'IDENTITY_UNKNOWN',
  LICENSE_OK: 'LICENSE_VALID',
  RENEW_LICENSE: 'LICENSE_EXPIRED',
  USE_LOG: 'LOG_CORRELATED',
  STALE_LOG: 'LOG_STALE',
  REFRESH_VERIFIED: 'AUDIT_PRESENT',
  VERIFY_REFRESH: 'AUDIT_ABSENT',
  SYNC_DELAY: 'GROUP_PRESENT',
  MISSING_GROUP: 'GROUP_ABSENT',
  SERVICE_OUTAGE: 'GLOBAL_OUTAGE',
  MISSING_INVENTORY: 'ROLES_UNKNOWN',
  REQUEST_VIEWER: 'VIEWER_MISSING',
  REFUSE_ADMIN: 'VIEWER_MISSING',
}
function factCode(...args: Parameters<typeof classify>) {
  if (args[0].samePrincipal === true && args[0].sameMailbox === false)
    return 'PRINCIPAL_MATCH'
  return factCodes[classify(...args)]
}
