import { randomBytes } from 'node:crypto'
import { MemoryStore } from '../db/store.js'
import { Vault } from '../privacy/vault.js'
import { pairs } from './cases.js'
import { fixture } from '../adapters/demo.js'
import { classify } from '../investigation/mock.js'

export async function privacyReport() {
  const db = new MemoryStore(),
    key = randomBytes(32)
  const auth = { tenant_id: 'demo', actor_id: 'tester', department_id: 'it' }
  const ticket = { ...auth, id: crypto.randomUUID(), scenario: 'B' as const }
  const vault = await Vault.open(db, ticket, key)
  const corpus = {
    email: ['han+it@corp.example', 'li.chen@test.example'],
    phone: ['13800138000', '+86 13900139000'],
    employeeId: ['EMP-101', 'emp_1202'],
    secret: [
      'Authorization: Bearer Ab1~+d/e==',
      'token=abc12345',
      'password=plain',
      'passwd: "two words"',
      "secret='phrase value'",
      '密码是 pass123',
      '密码为 pass123',
      '密码：pass123',
      '口令是 pass123',
      '密钥是 pass123',
      'api_key=KEYabc12345',
      'api_key="Ab!c 12345"',
      'Authorization: Bearer Ab12!c:DEF',
    ],
    unfamiliarChineseName: ['夏知微', '贺明远'],
  }
  const recall: Record<string, number> = {}
  for (const [kind, values] of Object.entries(corpus)) {
    let hits = 0
    for (const raw of values) {
      const text = await vault.text('反馈 ' + raw + ' 请核对')
      if (
        kind === 'secret'
          ? text === '反馈 [REDACTED] 请核对'
          : !text.includes(raw)
      )
        hits++
    }
    recall[kind] = hits / values.length
  }
  const diagnostic = {
    traceId: '3ce4b816a25c45bb971f01bb3cd46281',
    commitHash: '290cbe564d6bbce3fd48e39258d5528ee77d9d82',
    httpStatus: 403,
    errorCode: 'E403',
    version: 'v2.10.4',
    port: 8443,
    date: '2026-11-01',
  }
  const projected = (await vault.project({ diagnostic })) as {
    diagnostic: Record<string, unknown>
  }
  let restored = 0
  for (const email of corpus.email) {
    const ref = await vault.bind('EMAIL', email)
    if (vault.resolve(auth, ticket.id, ref, 'EMAIL') === email) restored++
  }
  let preserved = 0,
    total = 0
  for (const pair of pairs) {
    for (const c of pair.cases) {
      const adapter = fixture('B', c.facts)
      const email = adapter.directory.email
      const args: Parameters<typeof classify> = [
        adapter.get_login_sessions(email),
        adapter.directory,
        adapter.get_app_permissions(email),
        pair.question + (c.prompt ?? ''),
      ]
      const safe = (await vault.project(args)) as typeof args
      preserved += Number(classify(...args) === classify(...safe))
      total++
    }
  }
  return {
    recall,
    diagnosticChangeRate:
      Object.entries(diagnostic).filter(
        ([k, v]) => projected.diagnostic[k] !== v,
      ).length / Object.keys(diagnostic).length,
    toolRestoreRate: restored / corpus.email.length,
    ruleClassificationPreservation: preserved / total,
  }
}
if (import.meta.main) {
  const result = await privacyReport()
  console.log(
    JSON.stringify({
      ...result,
      ruleClassificationPreservationDefinition:
        '同一规则分类器在原始与脱敏输入上的判别保持率',
    }),
  )
  if (
    result.diagnosticChangeRate ||
    result.toolRestoreRate !== 1 ||
    result.ruleClassificationPreservation !== 1 ||
    Object.entries(result.recall).some(
      ([k, v]) => k !== 'unfamiliarChineseName' && v !== 1,
    )
  )
    process.exitCode = 1
}
