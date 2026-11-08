import { supabase } from './supabase.js'

// All agent-request reads/writes go through the Supabase client under RLS
// (supabase/migrations/0021_agent_requests.sql): only the requester can
// create/read their own request; only Mubarak (is_owner) can read all and
// decide. No new server route. One small function per query, in the same
// style as the other Supabase calls in Chat.jsx.

// The "effective agent" of a request: the assigned agent once Mubarak
// chose one, else the preferred agent, else null ("let Mubarak choose").
// A user may hold approved requests for MORE than one agent, but never
// two pending/approved requests for the same effective agent (DB trigger
// and partial unique index enforce it; the UI uses this to disable the
// submit button for an agent that is already covered).
export const effectiveAgentId = (request) =>
  request.assigned_agent_id ?? request.preferred_agent_id ?? null

const isActive = (request) => request.status === 'pending' || request.status === 'approved'

export const hasActiveRequestFor = (requests, agentId) =>
  requests.some((r) => isActive(r) && effectiveAgentId(r) === agentId)

export const approvedAgentIds = (requests) =>
  new Set(requests.filter((r) => r.status === 'approved').map((r) => r.assigned_agent_id).filter(Boolean))

// The requester's own requests, newest first. Empty until 0021 is live.
export async function fetchMyRequests(myId) {
  const { data, error } = await supabase
    .from('agent_requests')
    .select('*')
    .eq('requested_by', myId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// Pending requests for Mubarak's admin list, oldest first.
export async function fetchPendingRequests() {
  const { data, error } = await supabase
    .from('agent_requests')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function submitRequest({ requestedBy, preferredAgentId, message }) {
  const { data, error } = await supabase
    .from('agent_requests')
    .insert({
      requested_by: requestedBy,
      preferred_agent_id: preferredAgentId || null,
      message: message?.trim() || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Approve or reject. The welcome DM to the requester is sent by a DB
// trigger on approval (0021), not here — so the message cannot be
// forgotten by one code path and duplicated by another. Reassigning an
// already-approved request (same call, status 'approved', new agentId)
// is allowed; it does not send a second welcome.
export async function decideRequest({ id, decidedBy, status, agentId, reason }) {
  const { data, error } = await supabase
    .from('agent_requests')
    .update({
      status,
      assigned_agent_id: status === 'approved' ? agentId || null : null,
      rejection_reason: status === 'rejected' ? reason?.trim() || null : null,
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}
