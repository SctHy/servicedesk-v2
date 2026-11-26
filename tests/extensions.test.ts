import { expect, it } from 'bun:test'
import { Type } from 'typebox'
import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { MemoryStore } from '../src/db/store'
import { TenantScope } from '../src/db/tenant'
import { investigate } from '../src/investigation/engine'
import { decide } from '../src/changes/service'
import { Executor } from '../src/changes/executor'
import { application } from '../src/http/app'
import { fixture } from '../src/adapters/demo'
import { ExtensionRegistry } from '../src/extensions/registry'
import type { ServiceDeskExtension } from '../src/extensions/types'

const auth = { tenant_id: 'sandbox', actor_id: 'alice', department_id: 'engineering' }
const key = Buffer.alloc(32, 1)
const empty = Type.Object({}, { additionalProperties: false })
function quota(version: string, observe = async () => {}) {
  const writes: string[] = []
  let raised = false
  const ext: ServiceDeskExtension = {
    id: 'sandbox-quota',
    version,
    title: '配额',
    description: '审批沙盒配额',
    scenarios: [{ id: 'quota', title: '沙盒容量', adapter: () => fixture('A') }],
    uiManifest: {},
    observations: ['capacity', 'ownership'].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: empty,
      invalidatedBy: ['quota_state'],
      refreshArgs: () => ({}),
      async execute() {
        await observe()
        return { version, raised, owner: true }
      },
    })),
    actions: [
      {
        id: 'raise',
        app: 'sandbox',
        role: 'extra-capacity',
        requires: [
          { source: 'ownership', accepts: (data) => data.owner === true },
          { source: 'capacity', accepts: (data) => data.raised === false },
        ],
        draftTool: {
          name: 'draft_quota',
          label: '提高配额',
          description: '申请',
          executionMode: 'sequential',
          parameters: empty,
        },
        resourceKey: (c) => JSON.stringify([c.tenant_id, c.beneficiary_principal, 'quota']),
        read: async () => raised,
        apply: async () => {
          writes.push(version)
          raised = true
        },
        revoke: async () => {
          raised = false
        },
        bumpTopics: ['quota_state'],
      },
    ],
  }
  return { ext, writes }
}
function scripted(batches: string[][]): StreamFn {
  let turn = 0
  return (model) => {
    const calls = batches[turn++] ?? []
    const msg: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      model: model.id,
      provider: model.provider,
      timestamp: Date.now(),
      stopReason: calls.length ? 'toolUse' : 'stop',
      content: calls.length
        ? calls.map((name) => ({ type: 'toolCall', name, id: crypto.randomUUID(), arguments: {} }))
        : [{ type: 'text', text: '完成' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'done', reason: msg.stopReason as 'stop', message: msg })
    stream.end(msg)
    return stream
  }
}
function ticket() {
  return { ...auth, id: crypto.randomUUID(), scenario: 'quota' }
}
async function insert(db: MemoryStore) {
  const { department_id, ...t } = ticket()
  await db.add('tickets', t)
  return t
}

it('pins parallel reads and the sequential draft through approval, upgrade and job drain', async () => {
  await using db = new MemoryStore()
  const registry = new ExtensionRegistry()
  const both = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let started = 0
  const v1 = quota('1', async () => {
    if (++started === 2) both.resolve()
    await release.promise
  })
  const v2 = quota('2')
  registry.register(v1.ext)
  const old = await insert(db),
    fresh = await insert(db)
  const run = (t: typeof old, batches: string[][]) =>
    investigate(
      db,
      auth,
      t,
      '核对',
      key,
      async () => {},
      scripted(batches),
      fixture('A'),
      undefined,
      true,
      { timeoutMs: 5000 },
      undefined,
      undefined,
      registry,
    )
  const first = run(old, [['capacity', 'ownership'], ['draft_quota']])
  await both.promise
  registry.upgrade(v2.ext)
  expect(registry.status()[0]).toMatchObject({ version: '1', draining: true, activeRefs: 1 })
  await run(fresh, [['capacity']])
  expect((await db.rows('evidence', { ticket_id: fresh.id }))[0].data.version).toBe('2')
  release.resolve()
  expect((await first).toolFailures).toBe(0)
  const [change] = await db.rows('changes', { ticket_id: old.id })
  expect(change.extension_version).toBe('1')
  registry.unload(v2.ext.id)
  await decide(
    db,
    { ...auth, actor_id: 'carol', role: 'approver' },
    change.id,
    { decision: 'approve', payload_hash: change.payload_hash },
    false,
    undefined,
    registry,
  )
  const executor = new Executor(db, undefined, undefined, undefined, registry)
  await executor.run()
  await executor.run()
  expect(v1.writes).toEqual(['1'])
  expect(v2.writes).toEqual([])
  expect(registry.status()).toHaveLength(0)
  expect((await new TenantScope(db, auth.tenant_id).watermarks(old.id)).quota_state).toBeTruthy()
  registry.register(v1.ext)
  await run(old, [])
  const evidence = await db.rows('evidence', { ticket_id: old.id })
  expect(evidence.filter((e) => e.data.raised === true)).toHaveLength(2)
}, 12000)

it('rejects conflicting tools, missing policies, parallel writes and baseline privacy overrides', () => {
  const { ext } = quota('1'),
    registry = new ExtensionRegistry(),
    action = ext.actions[0]
  for (const bad of [
    { observations: [...ext.observations, ...ext.observations] },
    { actions: [{ ...action, requires: [] }] },
    { actions: [{ ...action, draftTool: { ...action.draftTool, executionMode: 'parallel' } }] },
    { privacy: { extraFieldKinds: { email: 'NAME' } } },
  ]) {
    expect(() => registry.register({ ...ext, ...bad } as ServiceDeskExtension)).toThrow()
  }
  expect(registry.status()).toEqual([])
})

it('requires independent privileged tenant control over extension discovery and ticket creation', async () => {
  await using db = new MemoryStore()
  const registry = new ExtensionRegistry()
  registry.register(quota('1').ext)
  const app = await application(db, key, undefined, undefined, undefined, registry)
  try {
    const toggle = (user: string) =>
      app.inject({
        method: 'POST',
        url: '/api/extensions/sandbox-quota/toggle',
        headers: { 'x-demo-user': user },
        payload: { enabled: false },
      })
    expect((await toggle('alice')).statusCode).toBe(403)
    expect((await toggle('carol')).statusCode).toBe(200)
    for (const [user, enabled] of [
      ['alice', false],
      ['guest', true],
    ] as const) {
      const headers = { 'x-demo-user': user }
      expect((await app.inject({ url: '/api/extensions', headers })).json()[0]).toMatchObject({
        enabled, version: '1', activeRefs: 0, scenarios: [{id:'quota',title:'沙盒容量'}],
        uiManifest: {
          observationMeta: {capacity:{title:'capacity'}, ownership:{title:'ownership'}},
          actions:[{id:'raise',app:'sandbox',role:'extra-capacity',title:'提高配额',standalone:false}],
        },
      })
      expect(
        (await app.inject({ method: 'POST', url: '/api/tickets', headers, payload: { scenario: 'quota' } }))
          .statusCode,
      ).toBe(enabled ? 201 : 400)
    }
  } finally {
    await app.close()
  }
})

it('drains an unloaded run version when its last investigation completes', async () => {
  await using db = new MemoryStore()
  const registry = new ExtensionRegistry()
  const started = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  registry.register(
    quota('1', async () => {
      started.resolve()
      await resume.promise
    }).ext,
  )
  const t = await insert(db)
  const run = investigate(
    db,
    auth,
    t,
    '核对',
    key,
    async () => {},
    scripted([['draft_quota'], ['capacity']]),
    fixture('A'),
    undefined,
    true,
    { timeoutMs: 5000 },
    undefined,
    undefined,
    registry,
  )
  await started.promise
  registry.upgrade(quota('2').ext)
  registry.unload('sandbox-quota')
  expect(registry.status()).toMatchObject([{ version: '1', draining: true, activeRefs: 1 }])
  resume.resolve()
  expect((await run).toolFailures).toBe(1)
  expect(await db.rows('changes', { ticket_id: t.id })).toEqual([])
  expect(registry.status()).toEqual([])
})
