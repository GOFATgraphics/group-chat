// Usage ledger: cached per-user, per-agent, per-week usage totals.
//
// Why: loadUsageForUser (server/routes/usage.js) re-downloads a user's
// ENTIRE DM history (fetchAll, all time, including message content) on
// every balance check, widget refresh and Settings open — and that download
// grows with history. That is the main remaining egress risk on the Free
// plan (log ingestion and egress are over quota this cycle). The ledger
// holds the same totals, aggregated once per message when it is stored
// (recordMessageUsage) or once per user on first use (backfillLedgerForUser),
// so the loaders read one small query instead of the whole history.
// See ~/workspace/group-chat-usage-cut-SPEC.md.
//
// The ledger holds RAW totals only. The two-tier rules (20 free
// credits/week from the fair-start week 2026-11-09, excess from additional
// tokens, owner exempt) are applied by the existing server code
// (balancesFor / twoTierBalances) on top of these totals, exactly as
// before. The credit math is unchanged: countMessage() is the single
// counter, used by the recorder, the backfill and the full-history path
// alike, so the three agree by construction.
//
// The ledger tables have RLS on with no policies for authenticated
// (service-role only, like credit_grants, migration 0023), so every
// read/write here uses the service-role client (admin()).
//
// Race note (backfill vs recorder): the backfill upserts bucket totals
// with REPLACE, so a message recorded by the recorder after the backfill
// fetched but before it upserted is overwritten (under-counted by that
// one message's credits). The window is the backfill's fetch→upsert
// (well under a second for a typical user) and it happens once per user,
// on first use — at most the credits of messages sent in that window,
// a fraction of a credit against a 20-credit weekly allowance. A message
// recorded before the fetch is already inside the fetched totals, so it
// is counted exactly once; a message after the upsert is recorded
// normally. Deleting a user's usage_ledger_state row re-runs the
// backfill and recomputes from history (a manual repair, if ever needed).

import { admin, check, HttpError } from './lib.js'
import { countMessage, weekStartOf, weekBounds, summarizeUsage } from './usage.js'

// Columns countMessage needs (mirrors MESSAGE_COLUMNS in
// server/routes/usage.js — kept here so this module does not import the
// routes file, which would be a circular import).
const LEDGER_MESSAGE_COLUMNS =
  'id, user_id, recipient_id, group_id, content, attachment_type, attachment_duration, call_duration, created_at'

// PostgREST returns at most 1000 rows per request; page through them
// (mirrors fetchAll in server/routes/usage.js).
async function fetchAllRows(adm, buildQuery) {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1)
    if (error) throw new HttpError(500, error.message)
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return rows
}

// Approved agent pairs for a user: agentId -> username. Mirrors the query
// in loadUsageForUser (server/routes/usage.js). The DB trigger
// enforce_agent_assignment() also guarantees a DM with an AI agent only
// exists where an approved request pairs them, so the recorder's is_ai
// check and this list agree.
async function approvedAgentMap(adm, userId) {
  const requests = check(
    await adm
      .from('agent_requests')
      .select('assigned_agent_id')
      .eq('requested_by', userId)
      .eq('status', 'approved')
      .not('assigned_agent_id', 'is', null),
  )
  const agentIds = [...new Set(requests.map((r) => r.assigned_agent_id))]
  if (!agentIds.length) return new Map()
  const profiles = check(await adm.from('profiles').select('id, username').in('id', agentIds))
  return new Map(profiles.map((p) => [p.id, p.username]))
}

// Record one stored message into the ledger. Best-effort: never throws
// into the send path — on any error it logs and returns false, and the
// loader falls back to the full-history computation (still correct, just
// slower). `m` is the inserted message row (from the insert's
// .select().single()). `adm` is the service-role client (defaults to
// admin()); the ledger function is service-role only, so the caller's
// own session cannot call it.
export async function recordMessageUsage(m, adm = null) {
  try {
    if (!m || m.group_id != null || m.recipient_id == null) return false
    const client = adm ?? admin()
    // Who is the agent? The AI side of the DM. (See the header note on
    // enforce_agent_assignment: a DM with an AI agent implies an approved
    // request, so this is the same pair the full-history computation
    // counts.)
    const { data: profiles, error } = await client
      .from('profiles')
      .select('id, is_ai')
      .in('id', [m.user_id, m.recipient_id])
    if (error) throw new Error(error.message)
    const byId = new Map((profiles ?? []).map((p) => [p.id, p]))
    const senderAi = Boolean(byId.get(m.user_id)?.is_ai)
    const recipientAi = Boolean(byId.get(m.recipient_id)?.is_ai)
    let userId
    let agentId
    if (senderAi && !recipientAi) {
      agentId = m.user_id
      userId = m.recipient_id
    } else if (recipientAi && !senderAi) {
      agentId = m.recipient_id
      userId = m.user_id
    } else {
      return false
    }
    const part = countMessage(m, userId, agentId)
    if (!part) return false
    const createdAt = m.created_at ? new Date(m.created_at) : new Date()
    const week = weekStartOf(createdAt).toISOString().slice(0, 10)
    const { error: rpcError } = await client.rpc('record_usage_ledger', {
      p_user_id: userId,
      p_agent_id: agentId,
      p_week_start: week,
      p_messages: part.messages,
      p_input_tokens: part.inputTokens,
      p_output_tokens: part.outputTokens,
      p_voice_minutes: part.voiceMinutes,
      p_voice_notes: part.voiceNotes,
      p_cost_usd: part.costUsd,
      p_credits: part.credits,
    })
    if (rpcError) throw new Error(rpcError.message)
    return true
  } catch (err) {
    console.error('usage ledger record (skipped)', err.message)
    return false
  }
}

// Aggregate raw DM rows into (agent, week) ledger rows. Pure function
// (same counting as the full-history path: approved pairs only, via
// countMessage). Returns { ledgerRows, maxId } — maxId is the largest
// message id seen, stored in usage_ledger_state.
export function aggregateRowsToLedger(rows, userId, agentIds) {
  const buckets = new Map()
  let maxId = 0
  for (const m of rows) {
    if (m?.id != null) maxId = Math.max(maxId, Number(m.id))
    if (!m || m.call_duration != null || m.recipient_id == null || m.group_id != null) continue
    let agentId = null
    if (m.user_id === userId && agentIds.includes(m.recipient_id)) agentId = m.recipient_id
    else if (agentIds.includes(m.user_id) && m.recipient_id === userId) agentId = m.user_id
    else continue
    const part = countMessage(m, userId, agentId)
    if (!part || !m.created_at) continue
    const week = weekStartOf(new Date(m.created_at)).toISOString().slice(0, 10)
    const key = `${agentId}|${week}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        user_id: userId,
        agent_id: agentId,
        week_start: week,
        messages: 0,
        input_tokens: 0,
        output_tokens: 0,
        voice_minutes: 0,
        voice_notes: 0,
        cost_usd: 0,
        credits: 0,
      }
      buckets.set(key, b)
    }
    b.messages += part.messages
    b.input_tokens += part.inputTokens
    b.output_tokens += part.outputTokens
    b.voice_minutes += part.voiceMinutes
    b.voice_notes += part.voiceNotes
    b.cost_usd += part.costUsd
    b.credits += part.credits
  }
  return { ledgerRows: [...buckets.values()], maxId }
}

// Backfill one user's ledger from their full history (one-time, on first
// use). Idempotent: the upsert REPLACES the bucket totals, so a re-run
// recomputes the same numbers (and two concurrent backfills agree).
// Returns true if the ledger is now usable for this user, false if the
// ledger is not available (table/function missing) — the caller then
// falls back to full history. `agentMap` is the approved agentId ->
// username map (pass it in so the caller does not query twice).
export async function backfillLedgerForUser(adm, userId, agentMap = null) {
  try {
    const map = agentMap ?? (await approvedAgentMap(adm, userId))
    const agentIds = [...map.keys()]
    const rows = agentIds.length
      ? await fetchAllRows(adm, () =>
          adm
            .from('messages')
            .select(LEDGER_MESSAGE_COLUMNS)
            .is('group_id', null)
            .not('recipient_id', 'is', null)
            .or(`user_id.eq.${userId},recipient_id.eq.${userId}`),
        )
      : []
    const { ledgerRows, maxId } = aggregateRowsToLedger(rows, userId, agentIds)
    if (ledgerRows.length) {
      const { error } = await adm
        .from('usage_ledger')
        .upsert(ledgerRows, { onConflict: 'user_id,agent_id,week_start' })
      if (error) throw new Error(error.message)
    }
    const { error: stateError } = await adm
      .from('usage_ledger_state')
      .upsert(
        { user_id: userId, backfilled_through_id: maxId, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      )
    if (stateError) throw new Error(stateError.message)
    return true
  } catch (err) {
    console.error('usage ledger backfill (falling back to history)', err.message)
    return false
  }
}

// Build the loadUsageForUser shape from ledger rows. Pure function.
// `agentMap` is agentId -> username (approved agents only).
export function buildUsageFromLedgerRows(ledgerRows, userId, agentMap, week) {
  const weekIso = week.weekStart.toISOString().slice(0, 10)
  const perAgent = [...agentMap.entries()].map(([agentId, username]) => {
    const all = {
      inputTokens: 0,
      outputTokens: 0,
      voiceMinutes: 0,
      voiceNotes: 0,
      messages: 0,
      costUsd: 0,
      credits: 0,
    }
    const wk = { inputTokens: 0, outputTokens: 0, credits: 0, messages: 0 }
    for (const r of ledgerRows) {
      if (r.agent_id !== agentId) continue
      all.inputTokens += Number(r.input_tokens ?? 0)
      all.outputTokens += Number(r.output_tokens ?? 0)
      all.voiceMinutes += Number(r.voice_minutes ?? 0)
      all.voiceNotes += Number(r.voice_notes ?? 0)
      all.messages += Number(r.messages ?? 0)
      all.costUsd += Number(r.cost_usd ?? 0)
      all.credits += Number(r.credits ?? 0)
      if (String(r.week_start ?? '').slice(0, 10) === weekIso) {
        wk.inputTokens += Number(r.input_tokens ?? 0)
        wk.outputTokens += Number(r.output_tokens ?? 0)
        wk.credits += Number(r.credits ?? 0)
        wk.messages += Number(r.messages ?? 0)
      }
    }
    return {
      agentId,
      agentUsername: username ?? 'AI agent',
      inputTokens: all.inputTokens,
      outputTokens: all.outputTokens,
      totalTokens: all.inputTokens + all.outputTokens,
      voiceMinutes: all.voiceMinutes,
      voiceNotes: all.voiceNotes,
      messages: all.messages,
      costUsd: all.costUsd,
      credits: all.credits,
      weekTokens: wk.inputTokens + wk.outputTokens,
      weekCredits: wk.credits,
      weekMessages: wk.messages,
    }
  })
  const byWeek = {}
  for (const r of ledgerRows) {
    if (!agentMap.has(r.agent_id)) continue
    const key = String(r.week_start ?? '').slice(0, 10)
    byWeek[key] = (byWeek[key] ?? 0) + Number(r.credits ?? 0)
  }
  const weekly = { byWeek, busiestWeekCredits: Math.max(0, ...Object.values(byWeek)) }
  return { perAgent, week, weekly, totals: summarizeUsage(perAgent) }
}

// Load one user's usage from the ledger (backfilling on first use).
// Returns the same shape as loadUsageForUser: { perAgent, week, weekly,
// totals }. Throws if the ledger is not available (table/function
// missing) — the caller falls back to the full-history computation.
// `adm` is the service-role client (the ledger tables are service-role
// only); the rows returned are that user's own aggregates, never message
// content and never another user's data.
export async function loadUsageFromLedger(adm, userId) {
  const week = weekBounds()
  const agentMap = await approvedAgentMap(adm, userId)
  if (!agentMap.size) {
    return {
      perAgent: [],
      week,
      weekly: { byWeek: {}, busiestWeekCredits: 0 },
      totals: summarizeUsage([]),
    }
  }
  const { data: state, error: stateError } = await adm
    .from('usage_ledger_state')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (stateError) throw new Error(stateError.message)
  if (!state) {
    const ok = await backfillLedgerForUser(adm, userId, agentMap)
    if (!ok) throw new Error('usage ledger unavailable')
  }
  const { data: rows, error } = await adm.from('usage_ledger').select('*').eq('user_id', userId)
  if (error) throw new Error(error.message)
  return buildUsageFromLedgerRows(rows ?? [], userId, agentMap, week)
}
