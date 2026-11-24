import type { Store, Auth, Chunk } from '../db/store.js'
export interface Retriever {
  search(auth: Auth, query: string, k?: number): Promise<Chunk[]>
}
export async function seed(db: Store) {
  await db.locked('seed', async (tx) => {
    for (const [id, department_id, visibility, body] of [
      [
        'desktop',
        'it',
        'tenant',
        'Desktop 403: compare the signed-in account with the directory before requesting access.',
      ],
      [
        'viewer',
        'it',
        'department',
        'Project B role mapping: verified team members needing read access request project-b:viewer.',
      ],
      [
        'finance',
        'finance',
        'department',
        'Restricted finance escalation contacts.',
      ],
    ] as const) {
      if (!(await tx.rows('kb_chunks', { id })).length)
        await tx.add('kb_chunks', {
          id,
          tenant_id: 'demo',
          department_id,
          visibility,
          app: 'project-b-app',
          code: '403',
          body,
        })
    }
  })
}
export class Lexical implements Retriever {
  constructor(private db: Store) {}
  async search(auth: Auth, query: string, k = 3) {
    const scope = { tenant_id: auth.tenant_id }
    const permitted = [
      ...(await this.db.rows('kb_chunks', { ...scope, visibility: 'tenant' })),
      ...(await this.db.rows('kb_chunks', {
        ...scope,
        visibility: 'department',
        department_id: auth.department_id,
      })),
    ]
    const terms = new Set(query.toLowerCase().match(/[a-z0-9-]+/g))
    return permitted
      .map((doc) => ({
        doc,
        score:
          (terms.has(doc.code) ? 10 : 0) +
          (terms.has(doc.app) ? 8 : 0) +
          [...terms].filter((t) => doc.body.toLowerCase().includes(t)).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
      .slice(0, k)
      .map((x) => x.doc)
  }
}
