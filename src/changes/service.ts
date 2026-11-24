import { createHash } from 'node:crypto'
import type { Store, Auth, Ticket, Evidence } from '../db/store.js'
import type { Change, Job } from './types.js'

export const now = () => new Date().toISOString()
export const error = (statusCode: number, message: string) =>
  Object.assign(Error(message), { statusCode })
export const privileged = (a: Auth) =>
  a.role === 'approver' || a.role === 'admin'
export const appName = 'project-b-app',
  viewer = 'project-b:viewer'
export const grantPolicies = [{
  app: appName,
  role: viewer,
  requires: [
    { source: 'get_login_sessions', accepts: (data: Evidence['data']) => data.samePrincipal === true },
    { source: 'get_app_permissions', accepts: (data: Evidence['data'], role: string, app: string) =>
      data.app === app && Array.isArray(data.roles) && !data.roles.includes(role) },
  ],
}]
export function resource(c: Change) {
  return JSON.stringify([c.tenant_id, c.app, c.beneficiary_principal])
}
export async function draft(
  db: Store,
  a: Auth,
  input: { app: unknown; role: unknown; reason: unknown },
  context?: { ticket: Ticket; beneficiary: string; evidence: Evidence[] },
) {
  const policy = grantPolicies.find((p) => p.app === input?.app && p.role === input?.role)
  if (!policy)
    throw error(403, 'Role outside grant policy')
  if (
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 2000
  )
    throw error(400, 'Invalid reason')
  const reason = input.reason.trim()
  if (
    context &&
    (context.ticket.actor_id !== a.actor_id ||
      context.ticket.tenant_id !== a.tenant_id ||
      !context.evidence.every((e) => e.ticket_id === context.ticket.id) ||
      !policy.requires.every(({ source, accepts }) => {
        const latest = context.evidence.filter((e) => e.source === source)
          .sort((a, b) => a.observed_at.localeCompare(b.observed_at)).at(-1)
        return latest && accepts(latest.data, policy.role, policy.app)
      }))
  )
    throw error(403, 'Missing supporting evidence')
  const payload = {
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
    .update(JSON.stringify(payload))
    .digest('hex')
  return db.locked('draft:' + hash, async (tx) => {
    const [existing] = await tx.rows('changes', {
      payload_hash: hash,
      status: 'pending_approval',
    })
    if (existing) return existing
    const c: Change = {
      ...payload,
      id: crypto.randomUUID(),
      payload_hash: hash,
      status: 'pending_approval',
      approver_id: null,
      decision_note: null,
      created_at: now(),
      updated_at: now(),
    }
    await tx.add('changes', c)
    return c
  })
}
export async function decide(
  db: Store,
  a: Auth,
  id: string,
  body: { payload_hash?: string; decision?: string; note?: string },
  resolve = false,
) {
  if (!privileged(a)) throw error(403, 'Approval permission required')
  const filter = { id, tenant_id: a.tenant_id }
  const [initial] = await db.rows('changes', filter)
  if (!initial) throw error(404, 'Change unavailable')
  return db.locked(resource(initial), async (tx) => {
    const [c] = await tx.rows('changes', filter)
    if (a.actor_id === c.requester_id || a.actor_id === c.beneficiary_principal)
      throw error(403, 'Independent reviewer required')
    if (body?.payload_hash !== c.payload_hash)
      throw error(409, 'Frozen hash mismatch')
    if (c.status !== (resolve ? 'manual_review' : 'pending_approval'))
      throw error(409, 'Change already transitioned')
    const decision = body.decision,
      note = body.note ?? ''
    if (
      typeof note !== 'string' ||
      note.length > 2000 ||
      (resolve && !note.trim())
    )
      throw error(400, 'Invalid review note')
    let status: Change['status']
    if (resolve) {
      if (decision !== 'succeeded' && decision !== 'failed')
        throw error(400, 'Invalid resolution')
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
    } else {
      if (decision !== 'approve' && decision !== 'reject')
        throw error(400, 'Invalid decision')
      status = decision === 'approve' ? 'approved' : 'rejected'
      if (status === 'approved') {
        const job: Job = {
          id: crypto.randomUUID(),
          tenant_id: c.tenant_id,
          change_id: id,
          resource_key: resource(c),
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
    }
    await tx.update('changes', filter, {
      status,
      ...(resolve ? {} : { approver_id: a.actor_id, decision_note: note }),
      updated_at: now(),
    })
    await tx.add('change_audit', {
      id: crypto.randomUUID(),
      change_id: id,
      action: status,
      note,
      actor_id: a.actor_id,
      created_at: now(),
    })
    return { id, status }
  })
}
