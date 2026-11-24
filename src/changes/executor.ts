import type { Store } from '../db/store.js'
import type { Job } from './types.js'
import { enqueue, now, viewer } from './service.js'

import type { PermissionsAdapter } from './permissions.js'

export class DemoPermissions implements PermissionsAdapter {
  revokes = 0
  writes = 0
  fault?: 'crash_after_external_write' | 'unknown_external_state'
  constructor(private db: Store) {}
  async read(key: string, role = viewer) {
    if (this.fault === 'unknown_external_state') return null
    return (
      (await this.db.rows('demo_grants', { resource_key: key, role })).length >
      0
    )
  }
  async revoke(key: string, role = viewer) {
    this.revokes++
    await this.db.removeGrant(key, role)
  }
  async grant(key: string, role = viewer) {
    this.writes++
    await this.db.add('demo_grants', { resource_key: key, role })
  }
}
const fence = (j: Job) => ({
  id: j.id,
  status: j.status,
  version: j.version,
  lease_owner: j.lease_owner,
  lease_until: j.lease_until,
})
export class Executor {
  readonly owner = crypto.randomUUID()
  constructor(
    private db: Store,
    readonly adapter: PermissionsAdapter = new DemoPermissions(db),
    private leaseMs = 30000,
  ) {}
  async run() {
    const jobs = [
      ...(await this.db.rows('jobs', { status: 'running' })),
      ...(await this.db.rows('jobs', { status: 'queued' })),
    ]
    for (const j of jobs.filter((job) => Date.parse(job.run_at) <= Date.now()))
      await this.step(j)
  }
  async step(seen: Job) {
    const claimed = await this.db.locked(seen.resource_key, async (tx) => {
      const siblings = await tx.rows('jobs', {
        resource_key: seen.resource_key,
      })
      const j = siblings.find((x) => x.id === seen.id)
      if (
        !j ||
        Date.parse(j.run_at) > Date.now() ||
        j.version !== seen.version ||
        (j.status !== 'queued' &&
          !(j.status === 'running' && Date.parse(j.lease_until!) <= Date.now()))
      )
        return
      if (
        siblings.some(
          (x) =>
            x.id !== j.id &&
            (x.status === 'running' || x.status === 'manual_review'),
        )
      )
        return
      const patch = {
        status: 'running' as const,
        version: j.version + 1,
        attempt_count: j.attempt_count + 1,
        lease_owner: this.owner,
        lease_until: new Date(Date.now() + this.leaseMs).toISOString(),
        updated_at: now(),
      }
      if ((await tx.update('jobs', fence(j), patch)) !== 1) return
      await tx.update(
        'changes',
        { id: j.change_id },
        { status: 'executing', updated_at: now() },
      )
      await tx.add('change_audit', {
        id: crypto.randomUUID(), change_id: j.change_id, actor_id: 'system',
        action: 'executing', note: j.kind, created_at: patch.updated_at,
      })
      return { ...j, ...patch }
    })
    if (!claimed) return
    await this.db.locked(seen.resource_key, async (tx) => {
      const [j] = await tx.rows('jobs', fence(claimed))
      if (!j || Date.parse(j.lease_until!) <= Date.now()) return
      const [change] = await tx.rows('changes', { id: j.change_id })
      let confirmed: boolean | null = null
      let expiredBeforeWrite = false
      const granting = j.kind === 'grant'
      const overlap =
        !granting &&
        (
          await tx.rows('changes', {
            tenant_id: change.tenant_id,
            app: change.app,
            role: change.role,
            beneficiary_principal: change.beneficiary_principal,
            status: 'succeeded',
          })
        ).some(
          (c) =>
            c.id !== change.id &&
            (!c.expires_at || Date.parse(c.expires_at) > Date.now()),
        )
      if (!overlap) {
        try {
          confirmed = await this.adapter.read(j.resource_key, change.role)
          expiredBeforeWrite =
            granting &&
            confirmed === false &&
            change.expires_at !== null &&
            Date.parse(change.expires_at) <= Date.now()
          if (!expiredBeforeWrite && confirmed === !granting) {
            if (Date.parse(j.lease_until!) <= Date.now()) return
            try {
              await this.adapter[j.kind](j.resource_key, change.role)
            } catch {
              // A timeout can follow a committed external write. Verify before deciding.
            }
            if (
              this.adapter instanceof DemoPermissions &&
              this.adapter.fault === 'crash_after_external_write'
            )
              return
            confirmed = await this.adapter.read(j.resource_key, change.role)
          }
        } catch {
          confirmed = null
        }
      }
      if (Date.parse(j.lease_until!) <= Date.now()) return
      const status = expiredBeforeWrite
        ? 'failed'
        : overlap || confirmed === granting
          ? 'succeeded'
          : 'manual_review'
      if (
        (await tx.update('jobs', fence(j), {
          status,
          version: j.version + 1,
          lease_owner: null,
          lease_until: null,
          last_error:
            status === 'succeeded'
              ? null
              : expiredBeforeWrite
                ? 'Expired before grant'
                : 'External permission unconfirmed',
          updated_at: now(),
        })) !== 1
      )
        return
      const action = status === 'succeeded' && !granting ? 'revoked' : status
      if (granting && status === 'succeeded' && change.expires_at)
        await enqueue(tx, change, 'revoke')
      await tx.add('change_audit', {
        id: crypto.randomUUID(),
        change_id: change.id,
        actor_id: 'system',
        action,
        note: overlap ? '其他有效授权仍需该角色' : j.kind,
        created_at: now(),
      })
      await tx.update(
        'changes',
        { id: j.change_id },
        {
          status: action,
          ...(action === 'revoked' && { revoked_at: now() }),
          updated_at: now(),
        },
      )
    })
  }
}
