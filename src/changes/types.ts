export type Change = {
  extension_id?: string | null
  extension_version?: string | null
  id: string
  tenant_id: string
  ticket_id: string | null
  requester_id: string
  beneficiary_principal: string
  app: string
  role: string
  reason: string
  evidence_ids: string[]
  payload_hash: string
  status:
    | 'pending_approval'
    | 'approved'
    | 'revoked'
    | 'rejected'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'manual_review'
  expires_at: string | null
  revoked_at: string | null
  approver_id: string | null
  decision_note: string | null
  created_at: string
  updated_at: string
}
export type Job = {
  traceparent?: string | null
  id: string
  tenant_id: string
  change_id: string
  kind: 'grant' | 'revoke'
  run_at: string
  resource_key: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'manual_review'
  version: number
  lease_owner: string | null
  lease_until: string | null
  attempt_count: number
  last_error: string | null
  created_at: string
  updated_at: string
}
