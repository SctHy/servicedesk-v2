import { randomBytes } from 'node:crypto'
import { streamSimple } from '@mariozechner/pi-ai'
import { MemoryStore, type Event, type Ticket } from '../db/store.js'
import { seed } from '../retrieval/lexical.js'
import { fixture } from '../adapters/demo.js'
import { investigate, type ModelSettings } from '../investigation/engine.js'
import { mockStream, classify } from '../investigation/mock.js'
import { pairs } from './cases.js'

const codes = new Set(pairs.flatMap((p) => p.cases.map((c) => c.expected)))
export function parseDecision(answer: string) {
  const matches = [...answer.matchAll(/\bDECISION[ \t*`]*[=:：＝][ \t*`]*([A-Z][A-Z0-9_]*)\b/gi)]
  const code = matches[0]?.[1]?.toUpperCase()
  return matches.length === 1 && codes.has(code) ? code : null
}

export async function runPairs(
  live = false,
  limit = pairs.length,
  settings?: ModelSettings,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > pairs.length)
    throw Error('PAIR_LIMIT must be 1 through 8')
  const results: {
    pair: number
    expected: string
    decision: string | null
    cited: boolean
    correct: boolean
    consistent: boolean
    leaked: boolean
    tools: number
    failed: boolean
    answerExcerpt: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    ms: number
  }[] = []
  for (const [index, pair] of pairs.slice(0, limit).entries()) {
    for (const c of pair.cases) {
      const started = Date.now(),
        db = new MemoryStore()
      const t: Ticket = {
        id: crypto.randomUUID(),
        tenant_id: 'demo',
        actor_id: 'tester',
        scenario: 'B',
      }
      const auth = { ...t, department_id: 'it' },
        adapter = fixture('B', c.facts)
      await db.add('tickets', t)
      await seed(db)
      const question =
        'bob@corp.example EMP-102 13800138000 token=syntheticSecret ' +
        pair.question +
        (c.prompt ?? '') +
        '。先调用工具，引用决定性证据的完整 evidenceId，说明理由，并只选一个结论 DECISION=代码。代码：' +
        [...codes].join(', ')
      let leaked = false,
        usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        failed = false
      const events: Event['data'][] = []
      try {
        usage = await investigate(
          db,
          auth,
          t,
          question,
          randomBytes(32),
          async (e) => {
            events.push(e)
          },
          (m, ctx, o) => {
            if (
              /bob|alias@|corp\.example|EMP-102|13800138000|syntheticSecret/i.test(
                JSON.stringify(ctx),
              )
            ) {
              leaked = true
              throw Error('Unsafe outbound context')
            }
            return (live ? streamSimple : mockStream())(m, ctx, o)
          },
          adapter,
          settings,
        )
      } catch (error) {
        if (error instanceof Error && 'usage' in error) usage = error.usage as typeof usage
        failed = true
      }
      const answer = String(events.find((e) => e.type === 'final')?.text ?? '')
      const facts = await db.rows('evidence', { ticket_id: t.id })
      const cited = pair.sources.every((source) =>
        facts.some((e) => e.source === source && answer.includes(e.id)),
      )
      const email = adapter.directory.email
      const rawDecision = classify(
        adapter.get_login_sessions(email),
        adapter.directory,
        adapter.get_app_permissions(email),
        question,
      )
      const decision = parseDecision(answer)
      results.push({
        pair: index + 1,
        expected: c.expected,
        decision,
        cited,
        correct: !failed && !leaked && cited && decision === c.expected,
        consistent: decision === rawDecision,
        leaked,
        tools: facts.length,
        failed,
        answerExcerpt: answer.slice(-2000),
        ...usage,
        ms: Date.now() - started,
      })
    }
  }
  const n = results.length
  return {
    mode: live ? 'live' : 'offline',
    accuracy: results.filter((r) => r.correct).length / n,
    pairedAccuracy:
      pairs
        .slice(0, limit)
        .filter((_, i) =>
          results.slice(2 * i, 2 * i + 2).every((r) => r.correct),
        ).length /
      (n / 2),
    consistency: results.filter((r) => r.consistent).length / n,
    zeroLeak: results.every((r) => !r.leaked),
    tools: results.reduce((a, r) => a + r.tools, 0),
    inputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
    totalTokens: results.reduce((a, r) => a + r.totalTokens, 0),
    ms: results.reduce((a, r) => a + r.ms, 0),
    results,
  }
}
if (import.meta.main) {
  const report = await runPairs(
    process.env.LIVE_MODEL === '1',
    Number(process.env.PAIR_LIMIT ?? pairs.length),
  )
  console.log(JSON.stringify(report))
  if (report.accuracy !== 1 || !report.zeroLeak) process.exitCode = 1
}
