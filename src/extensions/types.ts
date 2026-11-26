import type { AgentLoopConfig, AgentTool } from '@mariozechner/pi-agent-core'
import type { Store, Auth, Evidence, Ticket } from '../db/store.js'
import type { InvestigationSource } from '../adapters/source.js'
import type { PermissionsAdapter } from '../changes/permissions.js'
import type { Change } from '../changes/types.js'
import type { VaultOptions } from '../privacy/vault.js'

export type ToolDefinition = Pick<AgentTool, 'name' | 'label' | 'parameters' | 'description'>
export interface Observation extends ToolDefinition {
  invalidatedBy: readonly string[]
  uiMeta?: Record<string, unknown> & { title?: string; summaryFields?: readonly string[] }
  refreshArgs?(scope: string, ref: string): Record<string, unknown>
  execute(
    context: {
      db: Store
      auth: Auth
      adapter: InvestigationSource
      permissions: PermissionsAdapter
      resolve(scope: string, ref: string): string
      traceparent?: string
      signal: AbortSignal
    },
    args: Record<string, any>,
  ): unknown
}
type Effect = (
  adapter: PermissionsAdapter,
  key: string,
  change: Change,
  trace?: string,
) => Promise<void>
export interface Action {
  id: string
  app: string
  role: string
  draftTool: ToolDefinition & { executionMode: 'sequential' }
  allowStandaloneDraft?: boolean
  requires: readonly {
    source: string
    accepts(data: Evidence['data'], role: string, app: string): boolean
  }[]
  resourceKey(change: Change): string
  read(...args: Parameters<Effect>): Promise<boolean | null>
  apply: Effect
  revoke: Effect
  bumpTopics: readonly string[]
  uiMeta?: Record<string, unknown>
}
export interface ServiceDeskExtension {
  id: string
  version: string
  title: string
  description: string
  promptFragment?: string
  privacy?: VaultOptions
  observations: readonly Observation[]
  retrievers?: readonly Observation[]
  actions: readonly Action[]
  hooks?: Pick<AgentLoopConfig, 'beforeToolCall' | 'afterToolCall'>
  scenarios: readonly {
    id: string
    title: string
    adapter?: (ctx: {
      auth: Auth
      permissions: PermissionsAdapter
      demo: boolean
      ticket(): Promise<Ticket>
    }) => InvestigationSource | Promise<InvestigationSource>
  }[]
  uiManifest: Record<string, unknown> & { demoControls?: Record<string, readonly string[]> }
}
