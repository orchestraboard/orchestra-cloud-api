export type HubEventKind =
  | 'card.created' | 'card.updated' | 'card.moved' | 'card.claimed'
  | 'mail.sent'
  | 'agent.registered' | 'agent.presence'
  | 'milestone.created' | 'milestone.updated' | 'milestone.deleted'

export interface HubEvent {
  id: string
  org_id: string
  seq: number
  kind: HubEventKind
  board_id: string | null
  actor_device_id: string | null
  idempotency_key: string | null
  payload: unknown
  created_at: string
}

export interface HubCard {
  id: string
  org_id: string
  board_id: string
  number: number
  title: string
  description: string
  column: string
  owner_agent: string | null
  paths: string[]
  milestone_id: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface HubMilestone {
  id: string
  org_id: string
  board_id: string
  title: string
  description: string
  status: 'open' | 'shipped' | 'dropped'
  version: number
  created_at: string
  updated_at: string
}

export type HubAgentState = 'working' | 'idle' | 'waiting' | 'offline'

export interface HubAgent {
  id: string
  org_id: string
  board_id: string
  device_id: string | null
  name: string
  state: HubAgentState
  current_card_id: string | null
  activity: string | null
  last_heartbeat_at: string | null
}

export interface HubMail {
  id: string
  org_id: string
  board_id: string
  card_id: string | null
  kind: string
  subject: string | null
  body: string
  from_agent: string
  to_agent: string | null
  to_human: boolean
  reply_to: string | null
  created_at: string
  delivered_at: string | null
}
