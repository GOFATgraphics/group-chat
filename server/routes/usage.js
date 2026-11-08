import { route, auth, admin, check, HttpError } from '../lib.js'
import {
  PRICING,
  weekBounds,
  computePairUsage,
  summarizeUsage,
  weeklyCreditTotals,
  barRatios,
} from '../usage.js'

// Per-user token / credit usage, estimated from stored chat text
// (see server/usage.js for the method and its limits).
//
//   GET /api/usage      -> the ADMIN's own usage (owner only since
//                          8 Nov 2026 — see below). Works for a Supabase
//                          access token and for a gck_ personal API key.
//   GET /api/usage/bars  -> the caller's own bar ratios ONLY
//                          ({ weekBarPct, allTimeBarPct }, 0–100). Any
//                          signed-in user may call it; it carries NO
//                          tokens, credits, cost or counts, so the two
//                          progress bars in the Settings card can be
//                          shown to everyone while the figures stay
//                          admin-only (decided 8 Nov 2026).
//   GET /api/usage/all  -> every user's totals, admin (owner) only.
//                          Totals only — never message content.
//
// VISIBILITY (decided 8 Nov 2026, reversing the earlier "each user sees
// their own usage" rule): ONLY the admin (Mubarak, profiles.is_owner)
// sees usage numbers at all. Regular users see no figures anywhere in
// the UI, and GET /api/usage answers 403 for a non-owner. The numbers
// stay computed the same way; they are just never shown or served to
// anyone but the owner.
//
// Attribution rule (v1): a DM counts only where an APPROVED agent_requests
// row pairs the user with the agent. Within that DM the user's messages
// are input, the agent's replies are output. Group chat, call transcripts
// and file contents are out of v1. Full history is counted (backfill from
// the messages table); nothing new is collected.
//
// Privacy: /api/usage/all runs on the service-role client but returns
// aggregates only — no text, no per-message rows, no attachment names.
// /api/usage is owner-only, so no non-owner can read numbers from it
// even though it runs on the caller's own session.

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
  // The bars are this week scaled against the user's own busiest week
  // and against the all-time total — visuals, not a % of a limit. There
  // is no allowance and no cap.
  const ratios = barRatios(totals, busiestWeekCredits)
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
      weekBarPct: ratios.weekBarPct,
    },
  }
}

// Shared owner check (profiles.is_owner, via the service-role client).
// Throws 403 for anyone who is not the admin.
async function checkOwner(userId) {
  const adm = admin()
  const { data: me, error: meError } = await adm
    .from('profiles')
    .select('is_owner')
    .eq('id', userId)
    .single()
  if (meError) throw new HttpError(500, meError.message)
  if (!me?.is_owner) throw new HttpError(403, 'Only the admin can see usage')
}

// Load the caller's own usage from their approved agent pairs: the
// per-agent breakdown, the current week bounds, and the busiest week's
// credits. Shared by GET /api/usage (owner only) and GET /api/usage/bars
// (any signed-in user — but bars only ever returns ratios, see below).
async function loadMyUsage(sb, userId) {
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
  if (!agentIds.length) return { perAgent: [], week, busiestWeekCredits: 0 }
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
  return { perAgent, week, busiestWeekCredits }
}

// Own usage: the caller's session, so RLS limits the read to messages
// they can see. Approved pairs come from their own agent_requests.
// Owner only (see the header): a non-owner gets 403.
export const own = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    await checkOwner(userId)
    const { perAgent, week, busiestWeekCredits } = await loadMyUsage(sb, userId)
    return usageResponse(perAgent, week, busiestWeekCredits)
  },
})

// Bar ratios only: the two progress-bar widths for the caller's own
// "My usage" card, as 0–100 ratios. ANY signed-in user may call this —
// the response carries NO tokens, NO credits, NO cost and NO counts,
// so no figures can be read back from it; the bars are visuals only.
// Owner and non-owner get the same shape.
export const bars = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const { perAgent, busiestWeekCredits } = await loadMyUsage(sb, userId)
    return barRatios(summarizeUsage(perAgent), busiestWeekCredits)
  },
})

// Admin view: every user's totals. Owner only.
export const all = route({
  async GET(req) {
    const { userId } = await auth(req)
    const week = weekBounds()
    await checkOwner(userId)
    const adm = admin()

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
