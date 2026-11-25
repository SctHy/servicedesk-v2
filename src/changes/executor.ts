import { TenantScope } from '../db/tenant.js'
import { traceparent } from '../http/trace.js'
import { changeCommitted, notify } from '../http/events.js'
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
export class Executor {
  readonly owner = crypto.randomUUID()
  constructor(
    private db: Store,
    readonly adapter: PermissionsAdapter = new DemoPermissions(db),
    private leaseMs = 30000,
    private record?: (tenant: string, action: 'succeeded' | 'revoked' | 'manual_review') => void,
  ) {}
  async run() {
    const jobs = await this.db.query<Job>(
      `SELECT * FROM jobs WHERE
      ((status='queued' AND run_at <= $1) OR (status='running' AND lease_until <= $1))
      ORDER BY run_at ASC`,
      [now()],
    )
    for (const job of jobs) await this.step(job)
  }
  async step(seen: Job) {
    const claimed = await this.db.locked(seen.resource_key, async (tx) => {
      const scope = await TenantScope.inTransaction(tx, seen.tenant_id)
      const [eligible] = await tx.query<Job>(
        `SELECT * FROM jobs WHERE id=$2 AND version=$3 AND tenant_id=$4 AND resource_key=$5 AND
        ((status='queued' AND run_at <= $1) OR (status='running' AND lease_until <= $1))
        AND NOT EXISTS (SELECT 1 FROM jobs sibling WHERE sibling.resource_key=jobs.resource_key
          AND sibling.id<>jobs.id AND sibling.status IN ('running','manual_review'))
        ORDER BY run_at ASC FOR UPDATE SKIP LOCKED`,
        [now(), seen.id, seen.version, seen.tenant_id, seen.resource_key],
      )
      if (!eligible) return
      const [j] = await tx.query<Job>(
        `UPDATE jobs SET status='running', version=version+1,
        attempt_count=attempt_count+1, lease_owner=$2, lease_until=$3, updated_at=now()
        WHERE id=$1 RETURNING *`,
        [
          seen.id,
          this.owner,
          new Date(Date.now() + this.leaseMs).toISOString(),
        ],
      )
      await scope.update(
        'changes',
        { id: j.change_id },
        { status: 'executing', updated_at: now() },
      )
      await scope.addChild('change_audit', {
        id: crypto.randomUUID(),
        change_id: j.change_id,
        actor_id: 'system',
        action: 'executing',
        note: j.kind,
        created_at: j.updated_at,
      })
      const [change] = await scope.rows('changes', { id: j.change_id })
      const overlap =
        j.kind === 'revoke' &&
        (
          await tx.query(
            `SELECT 1 FROM changes
        WHERE id<>$1 AND tenant_id=$2 AND app=$3 AND role=$4 AND beneficiary_principal=$5
        AND status='succeeded' AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`,
            [
              change.id,
              change.tenant_id,
              change.app,
              change.role,
              change.beneficiary_principal,
            ],
          )
        ).length > 0
      return { j, change, overlap }
    })
    if (!claimed) return
    const { j, change, overlap } = claimed
    notify(this.db, change.tenant_id, 'change', change.id)
    const trace = traceparent(j.traceparent)
    const granting = j.kind === 'grant'
    let confirmed: boolean | null = null
    let expiredBeforeWrite = false
    if (!overlap) {
      try {
        confirmed = await this.adapter.read(j.resource_key, change.role, trace)
        expiredBeforeWrite =
          granting &&
          confirmed === false &&
          change.expires_at !== null &&
          Date.parse(change.expires_at) <= Date.now()
        if (!expiredBeforeWrite && confirmed === !granting) {
          if (Date.parse(j.lease_until!) <= Date.now()) return
          try {
            await this.adapter[j.kind](j.resource_key, change.role, trace)
          } catch {
            // A timeout can follow a committed external write. Verify before deciding.
          }
          if (
            this.adapter instanceof DemoPermissions &&
            this.adapter.fault === 'crash_after_external_write'
          )
            return
          confirmed = await this.adapter.read(j.resource_key, change.role, trace)
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
    const committed = await this.db.tx(async (tx) => {
      const scope = await TenantScope.inTransaction(tx, change.tenant_id)
      const updated = await tx.query(
        `UPDATE jobs SET status=$4, version=version+1,
        lease_owner=NULL, lease_until=NULL, updated_at=now(), last_error=$5
        WHERE id=$1 AND status='running' AND version=$2 AND lease_owner=$3 AND lease_until>now()
        RETURNING id`,
        [
          j.id,
          j.version,
          this.owner,
          status,
          status === 'succeeded'
            ? null
            : expiredBeforeWrite
              ? 'Expired before grant'
              : 'External permission unconfirmed',
        ],
      )
      if (!updated.length) return false
      const action = status === 'succeeded' && !granting ? 'revoked' : status
      if (granting && status === 'succeeded' && change.expires_at)
        await enqueue(scope, change, 'revoke', trace)
      await scope.addChild('change_audit', {
        id: crypto.randomUUID(),
        change_id: change.id,
        actor_id: 'system',
        action,
        note: overlap ? '其他有效授权仍需该角色' : j.kind,
        created_at: now(),
      })
      await scope.update(
        'changes',
        { id: j.change_id },
        {
          status: action,
          ...(action === 'revoked' && { revoked_at: now() }),
          updated_at: now(),
        },
      )
      return true
    })
    if (committed) {
      if (status !== 'failed') this.record?.(change.tenant_id, status === 'succeeded' && !granting ? 'revoked' : status)
      await changeCommitted(this.db, change.tenant_id, change.id)
    }
  }
}
