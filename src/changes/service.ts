import { defaultRegistry } from '../extensions/default.js'
import type { ExtensionSnapshot } from '../extensions/registry.js'
import { accessAction } from '../extensions/builtin/project-b-access.js'
import { TenantScope } from '../db/tenant.js'
import { changeCommitted, notify } from '../http/events.js'
import { createHash } from 'node:crypto'
import type { Store, Auth, Ticket, Evidence } from '../db/store.js'
import type { Change, Job } from './types.js'

export const now = () => new Date().toISOString()
export const error = (statusCode: number, message: string) => Object.assign(Error(message), { statusCode })
export const privileged = (a: Auth) => a.role === 'approver' || a.role === 'admin'
export { appName, viewer } from '../extensions/builtin/project-b-access.js'
export const grantPolicies = [accessAction]
export const resource = accessAction.resourceKey
export async function draft(
  db: Store,
  a: Auth,
  input: { app: unknown; role: unknown; reason: unknown; ttl_minutes?: number },
  context?: { ticket: Ticket; beneficiary: string; evidence: Evidence[] },
  registry = defaultRegistry,
  pinned?: ExtensionSnapshot,
) {
  const snapshot = pinned ?? registry.acquireSnapshot(a.tenant_id)
  try {
    if (snapshot.tenantId !== a.tenant_id) throw error(403, 'Snapshot tenant mismatch')
    const policy = snapshot.actions.find((p) => p.app === input?.app && p.role === input?.role)
    if (!policy || (!context && !policy.allowStandaloneDraft)) throw error(403, 'Role outside grant policy')
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000)
      throw error(400, 'Invalid reason')
    const reason = input.reason.trim()
    if (
      context &&
      (context.ticket.actor_id !== a.actor_id ||
        context.ticket.tenant_id !== a.tenant_id ||
        !context.evidence.every((e) => e.ticket_id === context.ticket.id) ||
        !policy.requires.every(({ source, accepts }) => {
          const latest = context.evidence
            .filter((e) => e.source === source)
            .sort((a, b) => a.observed_at.localeCompare(b.observed_at))
            .at(-1)
          return latest && accepts(latest.data, policy.role, policy.app)
        }))
    )
      throw error(403, 'Missing supporting evidence')
    const ttl = input.ttl_minutes
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > 10080))
      throw error(400, 'Invalid ttl_minutes')
    const expires_at = ttl === undefined ? null : new Date(Date.now() + ttl * 60000).toISOString()
    const ext = snapshot.extensions.find((e) => e.actions.includes(policy))!
    const payload = {
      extension_id: ext.id,
      extension_version: ext.version,
      tenant_id: a.tenant_id,
      ticket_id: context?.ticket.id ?? null,
      requester_id: a.actor_id,
      beneficiary_principal: context?.beneficiary ?? a.actor_id,
      app: policy.app,
      role: policy.role,
      reason,
      evidence_ids: (context?.evidence ?? []).map((e) => e.id).sort(),
    }
    const hash = createHash('sha256')
      .update(JSON.stringify(expires_at ? { ...payload, expires_at } : payload))
      .digest('hex')
    const result = await new TenantScope(db, a.tenant_id).locked('draft:' + hash, async (tx) => {
      const [existing] = await tx.rows('changes', {
        payload_hash: hash,
        status: 'pending_approval',
      })
      if (existing) return existing
      const c: Change = {
        ...payload,
        expires_at,
        revoked_at: null,
        id: crypto.randomUUID(),
        payload_hash: hash,
        status: 'pending_approval',
        approver_id: null,
        decision_note: null,
        created_at: now(),
        updated_at: now(),
      }
      await tx.add('changes', c)
      await tx.addChild('change_audit', {
        id: crypto.randomUUID(),
        change_id: c.id,
        actor_id: a.actor_id,
        action: c.status,
        note: '',
        created_at: c.created_at,
      })
      return c
    })
    snapshot.pin(result.id, policy)
    notify(db, a.tenant_id, 'change', result.id)
    return result
  } finally {
    if (!pinned) snapshot.release()
  }
}
export async function enqueue(
  tx: TenantScope,
  c: Change,
  kind: Job['kind'],
  traceparent?: string,
  key = resource(c),
) {
  if ((await tx.rows('jobs', { change_id: c.id, kind })).length) return
  const job: Job = {
    id: crypto.randomUUID(),
    tenant_id: c.tenant_id,
    change_id: c.id,
    kind,
    traceparent,
    run_at: kind === 'grant' ? now() : c.expires_at!,
    resource_key: key,
    status: 'queued',
    lease_owner: null,
    lease_until: null,
    version: 0,
    attempt_count: 0,
    last_error: null,
    created_at: now(),
    updated_at: now(),
  }
  await tx.add('jobs', job)
}
export async function decide(
  db: Store,
  a: Auth,
  id: string,
  body: { payload_hash?: string; decision?: string; note?: string },
  resolve = false,
  traceparent?: string,
  registry = defaultRegistry,
) {
  if (!privileged(a)) throw error(403, 'Approval permission required')
  const filter = { id, tenant_id: a.tenant_id }
  const [initial] = await new TenantScope(db, a.tenant_id).rows('changes', filter)
  if (!initial) throw error(404, 'Change unavailable')
  if (initial.status !== (resolve ? 'manual_review' : 'pending_approval'))
    throw error(409, 'Change already transitioned')
  const action = registry.actionFor(initial)
  const key = action.resourceKey(initial)
  const result = await new TenantScope(db, a.tenant_id).locked(key, async (tx) => {
    const [c] = await tx.rows('changes', filter)
    if (a.actor_id === c.requester_id || a.actor_id === c.beneficiary_principal)
      throw error(403, 'Independent reviewer required')
    if (body?.payload_hash !== c.payload_hash) throw error(409, 'Frozen hash mismatch')
    if (c.status !== (resolve ? 'manual_review' : 'pending_approval'))
      throw error(409, 'Change already transitioned')
    const decision = body.decision,
      note = body.note ?? ''
    if (typeof note !== 'string' || note.length > 2000 || (resolve && !note.trim()))
      throw error(400, 'Invalid review note')
    let status: Change['status']
    if (resolve) {
      if (decision !== 'succeeded' && decision !== 'failed') throw error(400, 'Invalid resolution')
      status = decision
      const [j] = await tx.rows('jobs', {
        change_id: id,
        status: 'manual_review',
      })
      if (
        !j ||
        (await tx.update(
          'jobs',
          {
            id: j.id,
            version: j.version,
            status: j.status,
            lease_owner: null,
            lease_until: null,
          },
          { status, version: j.version + 1, updated_at: now() },
        )) !== 1
      )
        throw error(409, 'Stale job')
      if (status === 'succeeded') {
        if (j.kind === 'revoke') status = 'revoked'
        else if (c.expires_at) await enqueue(tx, c, 'revoke', traceparent, key)
      }
    } else {
      if (decision !== 'approve' && decision !== 'reject') throw error(400, 'Invalid decision')
      status = decision === 'approve' ? 'approved' : 'rejected'
      if (status === 'approved') {
        await enqueue(tx, c, 'grant', traceparent, key)
      }
    }
    await tx.update('changes', filter, {
      status,
      ...(status === 'revoked' && { revoked_at: now() }),
      ...(resolve ? {} : { approver_id: a.actor_id, decision_note: note }),
      updated_at: now(),
    })
    await tx.addChild('change_audit', {
      id: crypto.randomUUID(),
      change_id: id,
      action: status,
      note,
      actor_id: a.actor_id,
      created_at: now(),
    })
    if (c.ticket_id && (status === 'succeeded' || status === 'revoked'))
      for (const topic of action.bumpTopics) await tx.bumpWatermark(c.ticket_id, topic)
    return { id, status }
  })
  if (
    ['rejected', 'failed', 'revoked'].includes(result.status) ||
    (result.status === 'succeeded' && !initial.expires_at)
  )
    registry.finish(id)
  await changeCommitted(db, a.tenant_id, id)
  return result
}
