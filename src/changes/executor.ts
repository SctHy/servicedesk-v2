import type { Store } from '../db/store.js'
import type { Job } from './types.js'
import { now, viewer } from './service.js'

import type { PermissionsAdapter } from './permissions.js'

export class DemoPermissions implements PermissionsAdapter {
  writes = 0
  fault?: 'crash_after_external_write' | 'unknown_external_state'
  constructor(private db: Store) {}
  async read(key: string) {
    if (this.fault === 'unknown_external_state') return null
    return (
      (await this.db.rows('demo_grants', { resource_key: key, role: viewer }))
        .length > 0
    )
  }
  async grant(key: string) {
    this.writes++
    await this.db.add('demo_grants', { resource_key: key, role: viewer })
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
    for (const j of jobs) await this.step(j)
  }
  async step(seen: Job) {
    const claimed = await this.db.locked(seen.resource_key, async (tx) => {
      const siblings = await tx.rows('jobs', {
        resource_key: seen.resource_key,
      })
      const j = siblings.find((x) => x.id === seen.id)
      if (
        !j ||
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
      return { ...j, ...patch }
    })
    if (!claimed) return
    await this.db.locked(seen.resource_key, async (tx) => {
      const [j] = await tx.rows('jobs', fence(claimed))
      if (!j || Date.parse(j.lease_until!) <= Date.now()) return
      let confirmed: boolean | null = null
      try {
        confirmed = await this.adapter.read(j.resource_key)
        if (confirmed === false) {
          if (Date.parse(j.lease_until!) <= Date.now()) return
          await this.adapter.grant(j.resource_key)
          if (this.adapter instanceof DemoPermissions && this.adapter.fault === 'crash_after_external_write') return
          confirmed = await this.adapter.read(j.resource_key)
        }
      } catch {
        try {
          confirmed = await this.adapter.read(j.resource_key)
        } catch {
          confirmed = null
        }
      }
      if (Date.parse(j.lease_until!) <= Date.now()) return
      const status = confirmed === true ? 'succeeded' : 'manual_review'
      if (
        (await tx.update('jobs', fence(j), {
          status,
          version: j.version + 1,
          lease_owner: null,
          lease_until: null,
          last_error: confirmed === true ? null : 'External grant unconfirmed',
          updated_at: now(),
        })) !== 1
      )
        return
      await tx.update(
        'changes',
        { id: j.change_id },
        { status, updated_at: now() },
      )
    })
  }
}
