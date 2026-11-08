import { route, auth, admin, check, HttpError } from '../lib.js'
import {
  PRICING,
  weekBounds,
  computePairUsage,
  summarizeUsage,
  weeklyCreditTotals,
} from '../usage.js'

// Per-user token / credit usage, estimated from stored chat text
// (see server/usage.js for the method and its limits).
//
//   GET /api/usage      -> the caller's own usage (their DMs with their
//                          approved AI agents). Works for a Supabase
//                          access token and for a gck_ personal API key.
//   GET /api/usage/all  -> every user's totals, admin (owner) only.
//                          Totals only — never message content.
//
// Attribution rule (v1): a DM counts only where an APPROVED agent_requests
// row pairs the user with the agent. Within that DM the user's messages
// are input, the agent's replies are output. Group chat, call transcripts
// and file contents are out of v1. Full history is counted (backfill from
// the messages table); nothing new is collected.
//
// Privacy: /api/usage runs on the caller's own session, so Supabase RLS
// already limits it to messages they can read. /api/usage/all runs on the
// service-role client but returns aggregates only — no text, no per-message
// rows, no attachment names.

const MESSAGE_COLUMNS =
  'id, user_id, recipient_id, content, attachment_type, attachment_duration, call_duration, created_at'

// PostgREST returns at most 1000 rows per request; page through them.
async function fetchAll(sb, buildQuery) {
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

function usageResponse(perAgent, week, busiestWeekCredits = 0) {
  const totals = summarizeUsage(perAgent)
  // The bar is this week scaled against the user's own busiest week so
  // far — a visual, not a % of a limit. There is no allowance and no cap.
  const weekBarPct =
    busiestWeekCredits > 0 ? Math.max(0, Math.min(100, (totals.weekCredits / busiestWeekCredits) * 100)) : 0
  return {
    estimated: true,
    benchmark: {
      model: PRICING.benchmarkModel,
      inputPerMillionUsd: PRICING.inputPerMillionUsd,
      outputPerMillionUsd: PRICING.outputPerMillionUsd,
      creditUsd: PRICING.creditUsd,
      note: 'Estimated from message text at Sonnet 5.5 rates. The agents run their own Muse, so this is not a bill from the AI company.',
    },
    week: {
      start: week.weekStart.toISOString(),
      reset: week.nextMonday.toISOString(),
      resetLabel: week.resetLabel,
    },
    agents: perAgent,
    totals: {
      ...totals,
      busiestWeekCredits,
      weekBarPct,
    },
  }
}

// Own usage: the caller's session, so RLS limits the read to messages
// they can see. Approved pairs come from their own agent_requests.
export const own = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const week = weekBounds()
    const requests = check(
      await sb
        .from('agent_requests')
        .select('assigned_agent_id')
        .eq('requested_by', userId)
        .eq('status', 'approved')
        .not('assigned_agent_id', 'is', null),
    )
    const agentIds = [...new Set(requests.map((r) => r.assigned_agent_id))]
    if (!agentIds.length) return usageResponse([], week)
    const profiles = check(await sb.from('profiles').select('id, username').in('id', agentIds))
    const names = Object.fromEntries(profiles.map((p) => [p.id, p.username]))
    // My DM rows, both directions (RLS already scopes to what I can read);
    // the pair filter in computePairUsage keeps only approved agents.
    const rows = await fetchAll(sb, () =>
      sb
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .is('group_id', null)
        .not('recipient_id', 'is', null)
        .or(`user_id.eq.${userId},recipient_id.eq.${userId}`),
    )
    const perAgent = agentIds.map((agentId) => ({
      agentId,
      agentUsername: names[agentId] ?? 'AI agent',
      ...computePairUsage(rows, userId, agentId, week.weekStart),
    }))
    const { busiestWeekCredits } = weeklyCreditTotals(rows, userId, agentIds)
    return usageResponse(perAgent, week, busiestWeekCredits)
  },
})

// Admin view: every user's totals. Owner only, checked against
// profiles.is_owner via the service-role client.
export const all = route({
  async GET(req) {
    const { userId } = await auth(req)
    const week = weekBounds()
    const adm = admin()
    const { data: me, error: meError } = await adm
      .from('profiles')
      .select('is_owner')
      .eq('id', userId)
      .single()
    if (meError) throw new HttpError(500, meError.message)
    if (!me?.is_owner) throw new HttpError(403, 'Only the admin can see everyone’s usage')

    const requests = check(
      await adm
        .from('agent_requests')
        .select('requested_by, assigned_agent_id')
        .eq('status', 'approved')
        .not('assigned_agent_id', 'is', null),
    )
    // userId -> approved agent ids
    const pairsByUser = new Map()
    for (const r of requests) {
      const list = pairsByUser.get(r.requested_by) ?? []
      if (!list.includes(r.assigned_agent_id)) list.push(r.assigned_agent_id)
      pairsByUser.set(r.requested_by, list)
    }
    const userIds = [...pairsByUser.keys()]
    if (!userIds.length) {
      return { ...usageResponse([], week), users: [], totals: { ...summarizeUsage([]), users: 0 } }
    }
    const profiles = check(await adm.from('profiles').select('id, username').in('id', userIds))
    const names = Object.fromEntries(profiles.map((p) => [p.id, p.username]))
    const agentIds = [...new Set(requests.map((r) => r.assigned_agent_id))]
    const agentProfiles = check(await adm.from('profiles').select('id, username').in('id', agentIds))
    const agentNames = Object.fromEntries(agentProfiles.map((p) => [p.id, p.username]))
    // Every DM row (service role, so RLS does not filter); the
    // approved-pairs check in computePairUsage is what scopes the
    // counting, and only aggregates ever leave the server.
    const rows = await fetchAll(adm, () =>
      adm.from('messages').select(MESSAGE_COLUMNS).is('group_id', null).not('recipient_id', 'is', null),
    )
    const users = userIds
      .map((uid) => {
        const perAgent = pairsByUser.get(uid).map((agentId) => ({
          agentId,
          agentUsername: agentNames[agentId] ?? 'AI agent',
          ...computePairUsage(rows, uid, agentId, week.weekStart),
        }))
        return { userId: uid, username: names[uid] ?? 'Someone', agents: perAgent, totals: summarizeUsage(perAgent) }
      })
      .sort((a, b) => b.totals.credits - a.totals.credits)
    const grand = summarizeUsage(users.map((u) => u.totals))
    return { ...usageResponse([], week), users, totals: { ...grand, users: users.length } }
  },
})

export default own
