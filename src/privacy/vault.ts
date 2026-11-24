import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import type { Store, Ticket, Auth } from '../db/store.js'

type Kind = 'EMAIL' | 'EMP' | 'NAME' | 'PHONE' | 'SECRET'
export type Span = { start: number; end: number; kind: Kind }
export interface EntityDetector {
  detect(text: string): Span[]
}
export class Rules implements EntityDetector {
  detect(text: string) {
    const spans: Span[] = []
    const match = (regex: RegExp, kind: Kind) => {
      for (const m of text.matchAll(regex))
        spans.push({ start: m.index!, end: m.index! + m[0].length, kind })
    }
    match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/gi, 'EMAIL')
    match(/(?<![\w-])(?:\+?86[- ]?)?1[3-9]\d{9}(?![\w-])/g, 'PHONE')
    match(/(?<!\[)\bEMP[-_]?\d+\b/gi, 'EMP')
    match(
      /["'](?:secret|password|passwd|api[_-]?key|token|authorization)["']\s*:\s*"(?:\\.|[^"\\])*"/gi,
      'SECRET',
    )
    match(/\b(?:sk-|ghp_)[\w-]{8,}/g, 'SECRET')
    match(
      /(?:authorization\s*:\s*(?:bearer\s+)?|bearer\s+|(?:\b(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]|(?:密码|口令|密钥)\s*(?:是|为|[:：=]))\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;，；。}]+)/gi,
      'SECRET',
    )
    // Weak credentials after explicit assignments are also sensitive. Entropy
    // is only consulted for unlabelled values following a key context.
    for (const m of text.matchAll(
      /\b(?:authorization|bearer|token|api[_-]?key)\s+([\w+./=~-]{16,})/gi,
    )) {
      const token = m[1],
        counts = new Map<string, number>()
      for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1)
      const entropy = [...counts.values()].reduce(
        (sum, n) => sum - (n / token.length) * Math.log2(n / token.length),
        0,
      )
      if (entropy >= 3.5)
        spans.push({
          start: m.index! + m[0].length - token.length,
          end: m.index! + m[0].length,
          kind: 'SECRET',
        })
    }
    return spans
  }
}
export class Vault {
  private values = new Map<string, string>()
  private constructor(
    private db: Store,
    readonly ticket: Ticket,
    private key: Buffer,
    private detector: EntityDetector,
  ) {}
  static async open(
    db: Store,
    ticket: Ticket,
    key: Buffer,
    detector: EntityDetector = new Rules(),
  ) {
    if (key.length !== 32) throw Error('MASK_KEY must contain 32 bytes')
    const v = new Vault(db, ticket, key, detector)
    for (const row of await db.rows('mask_bindings', v.scope())) {
      const [iv, tag, data] = row.cipher
        .split('.')
        .map((x) => Buffer.from(x, 'base64'))
      const c = createDecipheriv('aes-256-gcm', key, iv)
      c.setAAD(v.aad(row.ref))
      c.setAuthTag(tag)
      v.values.set(
        row.ref,
        Buffer.concat([c.update(data), c.final()]).toString(),
      )
    }
    return v
  }
  private scope() {
    return { tenant_id: this.ticket.tenant_id, ticket_id: this.ticket.id }
  }
  private aad(ref: string) {
    return Buffer.from(
      JSON.stringify([this.ticket.tenant_id, this.ticket.id, ref]),
    )
  }
  async bind(kind: Kind, value: string) {
    for (const [ref, raw] of this.values)
      if (raw === value && ref.startsWith('[' + kind + '_')) return ref
    const ref =
      '[' +
      kind +
      '_' +
      (1 +
        [...this.values.keys()].filter((r) => r.startsWith('[' + kind + '_'))
          .length) +
      ']'
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(this.aad(ref))
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()])
    await this.db.add('mask_bindings', {
      ...this.scope(),
      ref,
      cipher: [iv, c.getAuthTag(), data]
        .map((x) => x.toString('base64'))
        .join('.'),
    })
    this.values.set(ref, value)
    return ref
  }
  resolve(auth: Auth, scope: string, ref: string, kind: Kind) {
    const value = this.values.get(ref)
    if (
      scope !== this.ticket.id ||
      auth.actor_id !== this.ticket.actor_id ||
      auth.tenant_id !== this.ticket.tenant_id ||
      !ref.startsWith('[' + kind + '_') ||
      !value
    )
      throw Error('Invalid scoped reference')
    return value
  }
  async text(input: string) {
    const spans = this.detector.detect(input)
    const folded = input.toLowerCase()
    const references = new Map<Span, string>()
    for (const [ref, raw] of this.values) {
      const insensitive =
        ref.startsWith('[NAME_') &&
        /^[a-z]+$/i.test(raw) &&
        folded.length === input.length
      const subject = insensitive ? folded : input,
        search = insensitive ? raw.toLowerCase() : raw
      for (
        let i = subject.indexOf(search);
        i >= 0;
        i = subject.indexOf(search, i + raw.length)
      ) {
        const span = {
          start: i,
          end: i + raw.length,
          kind: ref.slice(1, ref.indexOf('_')) as Kind,
        }
        spans.unshift(span)
        references.set(span, ref)
      }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end)
    let cursor = 0,
      result = ''
    for (const s of spans) {
      if (s.start < cursor) continue
      result +=
        input.slice(cursor, s.start) +
        (s.kind === 'SECRET'
          ? '[REDACTED]'
          : (references.get(s) ??
            (await this.bind(s.kind, input.slice(s.start, s.end)))))
      cursor = s.end
    }
    return result + input.slice(cursor)
  }
  async project(obj: unknown, field = ''): Promise<unknown> {
    if (typeof obj === 'string') {
      const kind = (
        { email: 'EMAIL', employeeId: 'EMP', name: 'NAME' } as Record<
          string,
          Kind
        >
      )[field]
      if (typeof kind === 'string' && obj && !this.values.has(obj))
        return this.bind(kind, obj)
      return this.text(obj)
    }
    if (Array.isArray(obj)) {
      const out = []
      for (const x of obj) out.push(await this.project(x))
      return out
    }
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = Object.create(null)
      for (const [k, v] of Object.entries(obj)) {
        if (
          /^(secret|password|passwd|api[_-]?key|authorization|token)$/i.test(k)
        )
          continue
        if (
          field === 'diagnostic' &&
          ![
            'traceId',
            'commitHash',
            'errorCode',
            'httpStatus',
            'version',
            'port',
            'date',
          ].includes(k)
        )
          continue
        out[await this.text(k)] = await this.project(v, k)
      }
      return out
    }
    return obj
  }
  gateway(
    next: StreamFn,
    observe?: (summary: string) => Promise<void>,
  ): StreamFn {
    return async (model, context, options) => {
      // Pi uses name for protocol identifiers. Apply free-text rules to these too,
      // but reserve structured field policy for adapter outputs.
      const scrub = async (x: unknown): Promise<unknown> => {
        if (typeof x === 'string') return this.text(x)
        if (Array.isArray(x)) {
          const a = []
          for (const y of x) a.push(await scrub(y))
          return a
        }
        if (x && typeof x === 'object') {
          const out: Record<string, unknown> = Object.create(null)
          for (const [k, v] of Object.entries(x))
            if (
              !/^(secret|password|passwd|authorization|api[_-]?key|token)$/i.test(
                k,
              )
            )
              out[await this.text(k)] = await scrub(v)
          return out
        }
        return x
      }
      const safe = (await scrub({
        ...context,
        tools: context.tools?.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      })) as typeof context
      const wire = JSON.stringify(safe)
      if (
        [...this.values.values()].some((v) =>
          wire.includes(JSON.stringify(v).slice(1, -1)),
        ) ||
        this.detector.detect(wire).length
      )
        throw Error('Outbound privacy check failed')
      await observe?.(
        JSON.stringify({
          messages: safe.messages.length,
          tools: safe.tools?.map((t) => t.name),
          latest: safe.messages.at(-1)?.content,
        }).slice(0, 3000),
      )
      return next(model, safe, {
        apiKey: options?.apiKey,
        signal: options?.signal,
        reasoning: options?.reasoning,
        thinkingBudgets: options?.thinkingBudgets,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        cacheRetention: options?.cacheRetention,
        transport: options?.transport,
        timeoutMs: options?.timeoutMs,
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
      })
    }
  }
}
