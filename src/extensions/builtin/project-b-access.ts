import { Type } from 'typebox'
import { Lexical } from '../../retrieval/lexical.js'
import { fixture } from '../../adapters/demo.js'
import { evidenceSources } from '../../adapters/source.js'
import type { Action, Observation, ServiceDeskExtension } from '../types.js'

export const appName = 'project-b-app',
  viewer = 'project-b:viewer'
export const accessAction: Action = {
  allowStandaloneDraft: true,
  id: 'project-b-viewer',
  app: appName,
  role: viewer,
  requires: [
    { source: 'get_login_sessions', accepts: (data) => data.samePrincipal === true },
    {
      source: 'get_app_permissions',
      accepts: (data, role, app) =>
        data.app === app && Array.isArray(data.roles) && !data.roles.includes(role),
    },
  ],
  draftTool: {
    name: 'draft_access_change',
    label: '起草权限申请',
    description:
      'Draft for approval after confirming a matching principal and missing role. Allowed grants: ' +
      appName +
      '/' +
      viewer,
    executionMode: 'sequential',
    parameters: Type.Object({ role: Type.Literal(viewer) }, { additionalProperties: false }),
  },
  resourceKey: (c) => JSON.stringify([c.tenant_id, c.app, c.beneficiary_principal]),
  read: (p, key, c, t) => p.read(key, c.role, t),
  apply: (p, key, c, t) => p.grant(key, c.role, t),
  revoke: (p, key, c, t) => p.revoke(key, c.role, t),
  bumpTopics: ['access_state'],
  uiMeta: { card: 'access-change' },
}
const observations: Observation[] = (
  ['get_login_sessions', 'get_directory_profile', 'get_app_permissions', 'get_service_events'] as const
).map((name) => ({
  name,
  label: name,
  description: 'Read current ' + name.slice(4) + ' for the scoped email reference',
  parameters: Type.Object(
    { scope: Type.String(), ref: Type.String() },
    { additionalProperties: false },
  ),
  invalidatedBy: evidenceSources.get(name)?.invalidatedBy ?? [],
  uiMeta: {
    card: name,
    title: {
      get_login_sessions: '登录会话',
      get_directory_profile: '目录档案',
      get_app_permissions: '应用权限',
      get_service_events: '服务事件',
    }[name],
  },
  async execute({ auth, adapter, permissions, resolve, traceparent }, args) {
    const raw = await adapter[name](resolve(args.scope, args.ref))
    if ('roles' in raw && Array.isArray(raw.roles) && raw.app === appName) {
      const granted = await permissions.read(
        JSON.stringify([auth.tenant_id, raw.app, adapter.directory.name]),
        viewer,
        traceparent,
      )
      return {
        ...raw,
        roles: granted === null ? null : granted ? [...new Set([...raw.roles, viewer])] : raw.roles,
      }
    }
    return raw
  },
}))
export const projectBAccess: ServiceDeskExtension = {
  id: 'project-b-access',
  version: '1',
  title: '项目 B 访问权限',
  description: '项目 B 排障与最小权限授予及回收',
  promptFragment:
    '判断账号归属以权威主体比对 samePrincipal 为准，邮箱或别名只能辅助判断。若提供 draft_access_change 工具，在本轮取证确认主体匹配且缺少只读权限时起草待审批申请。',
  observations,
  retrievers: [
    {
      name: 'search_runbooks',
      label: 'search_runbooks',
      description: 'Search permitted troubleshooting manuals',
      parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      invalidatedBy: [],
      uiMeta: { card: 'knowledge', title: '排障手册' },
      execute: async ({ db, auth }, args) => ({
        documents: await new Lexical(db).search(auth, args.query),
      }),
    },
  ],
  actions: [accessAction],
  scenarios: [
    { id: 'A', title: '桌面端 403，网页正常', adapter: () => fixture('A') },
    {
      id: 'B',
      title: '项目 B 只读访问被拒，请勿授予管理员权限',
      async adapter({ auth, permissions, demo, ticket }) {
        const source: import('../../adapters/source.js').InvestigationSource = fixture('B')
        if (demo) {
          source.sessionUpdatedAt = (await ticket()).session_updated_at ?? undefined
          source.get_login_sessions = async (email) => {
            const wrong = (await ticket()).session === 'wrong_account'
            const granted = await permissions.read(
              JSON.stringify([auth.tenant_id, appName, source.directory.name]),
              viewer,
            )
            return fixture('B', {
              webStatus: granted ? 200 : 403,
              desktopStatus: !wrong && granted ? 200 : 403,
              ...(wrong && { principal: 'external-71', sessionEmail: 'other@personal.example' }),
            }).get_login_sessions(email)
          }
        }
        return source
      },
    },
  ],
  uiManifest: {
    demoControls: { A: ['fault'], B: ['fault', 'session'] },
    evidenceCards: observations.map((o) => o.name),
    changeCards: ['access-change'],
    operations: ['project-b-viewer'],
  },
}
