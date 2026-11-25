import { EventEmitter } from 'node:events'
import { PgStore, type Store } from '../db/store.js'

const buses = new WeakMap<Store, EventEmitter>()
export function events(db: Store) {
  let bus = buses.get(db)
  if (!bus) {
    bus = new EventEmitter()
    bus.setMaxListeners(0)
    buses.set(db, bus)
  }
  return bus
}
export function notify(
  db: Store,
  tenant: string,
  type: 'change' | 'ticket' | 'fault',
  id?: string,
) {
  events(db).emit('tenant:' + tenant, { type, id })
}

export async function changeCommitted(db: Store, tenantId: string, id: string) {
  if (db instanceof PgStore) {
    await db.query("SELECT pg_notify('desk_events', $1)", [JSON.stringify({ tenantId, type: 'change', id, wake: true })])
  } else {
    notify(db, tenantId, 'change', id)
    events(db).emit('jobs')
  }
}

export function listenChanges(db: PgStore) {
  return db.listenEvents(payload => {
    let event
    try { event = JSON.parse(payload) } catch { return }
    if (event?.kind === 'run' && typeof event.runId === 'string') {
      events(db).emit('run:' + event.runId)
      return
    }
    if (event?.type !== 'change' || typeof event.tenantId !== 'string' ||
        typeof event.id !== 'string') return
    notify(db, event.tenantId, 'change', event.id)
    if (event.wake === true) events(db).emit('jobs')
  })
}
