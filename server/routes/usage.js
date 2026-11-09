import { route, auth, admin, check, body, HttpError } from '../lib.js'
import {
  PRICING,
  weekBounds,
  computePairUsage,
  summarizeUsage,
  weeklyCreditTotals,
  barRatios,
  twoTierBalances,
} from '../usage.js'
import { loadUsageFromLedger } from '../usageLedger.js'

// Per-user token / credit usage, estimated from stored chat text
// (see server/usage.js for the method and its limits).
//
//   GET /api/usage      -> the ADMIN's own usage (owner only). Works for
//                          a Supabase access token and for a gck_
//                          personal API key.
//   GET /api/usage/bars  -> the caller's own bar ratios ONLY
//                          ({ weekBarPct, additionalBarPct }, 0–100). Any
//                          signed-in user may call it; it carries NO
//                          tokens, credits, cost or counts, so the two
//                          progress bars in the Settings card can be
//                          shown to everyone while the figures stay
//                          admin-only (decided 8 Nov 2026).
//   GET /api/usage/all  -> every user's totals, admin (owner) only.
//                          Totals only — never message content.
//   GET /api/usage/balance?user=<username>
//                       -> one user's remaining balance, for the AGENTS:
//                          free credits left this week, additional
//                          tokens left, and whether they are out. The
//                          caller may only ask about a user they are
//                          approved to serve (see below).
//   POST /api/usage/grant { username, credits }
//                       -> grant additional tokens to a user. Admin
//                          (owner) only.
//
// TWO-TIER MODEL (decided 8 Nov 2026, reversing the earlier
// "display-only, no limit" rule): each user gets 20 free credits per
// Mon–Sun week; any usage above that draws from their additional-tokens
// balance (granted by the admin only, never expires, starts at 0).
// When both are used up, the agent tells the user they are out until
// Monday or until more tokens are added (exact wording in
// public/agent-api.md §6). The owner is EXEMPT from the cutoff — his
// usage is still counted and shown, but he is never out of credits.
// Fair-start rule: excess counts only for weeks starting on/after Mon
// 2026-11-09; usage before that was under the old display-only regime
// and consumes no additional tokens.
//
// VISIBILITY (decided 8 Nov 2026, reversing the earlier "each user sees
// their own usage" rule): ONLY the admin (Mubarak, profiles.is_owner)
// sees usage numbers at all. Regular users see no figures anywhere in
// the UI, and GET /api/usage answers 403 for a non-owner. The numbers
// stay computed the same way; they are just never shown or served to
// anyone but the owner. The one exception is GET /api/usage/balance:
// an agent may read the REMAINING balance (not the usage history) of
// exactly the user it is approved to serve, so it can stop when that
// user is out.
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
//
// Grants table: public.credit_grants (migration 0023). Until that
// migration is applied live, the grants lookups below fail soft and
// treat the granted total as 0 — the endpoints must never 500 just
// because the table does not exist yet.

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

// Additional tokens granted to one user (sum of their credit_grants
// rows). FAILS SOFT: if the table does not exist yet (migration 0023
// not applied live) or the read errors for any other reason, the
// granted total is 0 — never a 500.
async function loadGrantsTotal(adm, userId) {
  try {
    const { data, error } = await adm.from('credit_grants').select('credits').eq('user_id', userId)
    if (error) throw new Error(error.message)
    return (data ?? []).reduce((sum, r) => sum + Number(r.credits ?? 0), 0)
  } catch (err) {
    console.error('credit_grants lookup (treated as 0)', err.message)
    return 0
  }
}

// Same, for many users at once: userId -> granted total. Fails soft
// like loadGrantsTotal (empty map on error).
async function loadGrantsTotals(adm, userIds) {
  const totals = new Map()
  if (!userIds.length) return totals
  try {
    const rows = await fetchAll(adm, () =>
      adm.from('credit_grants').select('user_id, credits').in('user_id', userIds),
    )
    for (const r of rows) {
      totals.set(r.user_id, (totals.get(r.user_id) ?? 0) + Number(r.credits ?? 0))
    }
  } catch (err) {
    console.error('credit_grants lookup (treated as 0)', err.message)
  }
  return totals
}

function usageResponse(perAgent, week, twoTier) {
  const totals = summarizeUsage(perAgent)
  // Bars: this week vs the 20-credit free limit, and additional tokens
  // used vs granted — visuals, not figures.
  const ratios = barRatios(twoTier)
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
    // Two-tier balances (flat, per the approved shape).
    ...twoTier,
    agents: perAgent,
    totals: {
      ...totals,
      weekBarPct: ratios.weekBarPct,
      additionalBarPct: ratios.additionalBarPct,
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

async function isOwnerId(adm, userId) {
  const { data: me, error } = await adm.from('profiles').select('is_owner').eq('id', userId).single()
  if (error) return false
  return Boolean(me?.is_owner)
}

// Load one user's usage from their approved agent pairs: the per-agent
// breakdown, the current week bounds, and the per-week credit totals
// (for the two-tier excess sum). `sb` is the caller's own session for
// /api/usage and /api/usage/bars (RLS scopes the read); the
// service-role client for /api/usage/balance (the caller is an agent
// asking about its user, and only aggregates leave the server).
//
// The cached usage ledger is tried first (one small query, no message
// content — see server/usageLedger.js). If the ledger is not available
// yet (migration 0025 not applied live) or any ledger read fails, this
// falls back to the full-history computation below — same numbers, just
// slower. The endpoints never 500 because of the ledger.
export async function loadUsageForUser(sb, userId) {
  try {
    return await loadUsageFromLedger(admin(), userId)
  } catch (err) {
    console.error('usage ledger read (falling back to history)', err.message)
  }
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
  if (!agentIds.length) {
    return { perAgent: [], week, weekly: { byWeek: {}, busiestWeekCredits: 0 }, totals: summarizeUsage([]) }
  }
  const profiles = check(await sb.from('profiles').select('id, username').in('id', agentIds))
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.username]))
  // This user's DM rows, both directions; the pair filter in
  // computePairUsage keeps only approved agents.
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
  const weekly = weeklyCreditTotals(rows, userId, agentIds)
  return { perAgent, week, weekly, totals: summarizeUsage(perAgent) }
}

// The two-tier balances for a user whose usage is already loaded.
export async function balancesFor(adm, userId, loaded, isOwner = false) {
  const granted = await loadGrantsTotal(adm, userId)
  return twoTierBalances({
    byWeek: loaded.weekly.byWeek,
    weekCredits: loaded.totals.weekCredits,
    granted,
    isOwner,
  })
}

// Own usage: the caller's session, so RLS limits the read to messages
// they can see. Approved pairs come from their own agent_requests.
// Owner only (see the header): a non-owner gets 403.
export const own = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    await checkOwner(userId)
    const loaded = await loadUsageForUser(sb, userId)
    const twoTier = await balancesFor(admin(), userId, loaded, true)
    return usageResponse(loaded.perAgent, loaded.week, twoTier)
  },
})

// Bar ratios only: the two progress-bar widths for the caller's own
// "My usage" card, as 0–100 ratios. ANY signed-in user may call this —
// the response carries NO tokens, NO credits, NO cost and NO counts,
// so no figures can be read back from it; the bars are visuals only.
// Week bar = this week vs the 20-credit free limit; additional bar =
// additional tokens used vs granted (0 when nothing granted).
// Owner and non-owner get the same shape.
export const bars = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const loaded = await loadUsageForUser(sb, userId)
    const twoTier = await balancesFor(admin(), userId, loaded, false)
    return barRatios(twoTier)
  },
})

// Balance for an agent: the remaining balance of ONE user, so the agent
// can check before replying in that user's DM and stop when they are
// out (see public/agent-api.md §6). The caller may only ask about a
// user they are APPROVED to serve — an approved agent_requests row must
// pair the caller (the agent member) with the named user — otherwise
// 403. Unknown user → 404. Returns remaining balances only, never the
// usage history or any message content.
export const balance = route({
  async GET(req) {
    const { userId } = await auth(req)
    const username = String(req.query?.user ?? '').trim().toLowerCase()
    if (!username) throw new HttpError(400, 'Pass ?user=<username>')
    const adm = admin()
    const { data: target, error: targetError } = await adm
      .from('profiles')
      .select('id, username, is_owner')
      .eq('username', username)
      .maybeSingle()
    if (targetError) throw new HttpError(500, targetError.message)
    if (!target) throw new HttpError(404, `No member named "${username}"`)
    // The caller must be an approved agent for this user.
    const { data: pair, error: pairError } = await adm
      .from('agent_requests')
      .select('id')
      .eq('requested_by', target.id)
      .eq('assigned_agent_id', userId)
      .eq('status', 'approved')
      .limit(1)
    if (pairError) throw new HttpError(500, pairError.message)
    if (!pair?.length) {
      throw new HttpError(403, 'You are not an approved agent for this user')
    }
    const loaded = await loadUsageForUser(adm, target.id)
    const twoTier = await balancesFor(adm, target.id, loaded, Boolean(target.is_owner))
    return {
      username: target.username,
      freeRemaining: twoTier.weekFreeRemaining,
      additionalRemaining: twoTier.additionalRemaining,
      outOfCredits: twoTier.outOfCredits,
      weekResetDate: loaded.week.resetLabel,
    }
  },
})

// Validate a grant body. Exported for tests. Returns the cleaned
// { username, credits } or throws 400.
export function parseGrant(b) {
  const username = String(b?.username ?? '').trim().toLowerCase()
  if (!username) throw new HttpError(400, 'Pass { "username": "<username>", "credits": <number> }')
  const credits = Number(b?.credits)
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new HttpError(400, 'credits must be a number greater than 0')
  }
  return { username, credits }
}

// Grant additional tokens to a user. Admin (owner) only. The balance
// never expires and starts at 0; each grant adds one credit_grants row.
// Returns the user's updated additional balance.
export const grant = route({
  async POST(req) {
    const { userId } = await auth(req)
    await checkOwner(userId)
    const { username, credits } = parseGrant(body(req))
    const adm = admin()
    const { data: target, error: targetError } = await adm
      .from('profiles')
      .select('id, username')
      .eq('username', username)
      .maybeSingle()
    if (targetError) throw new HttpError(500, targetError.message)
    if (!target) throw new HttpError(400, `No member named "${username}"`)
    const { error: insertError } = await adm.from('credit_grants').insert({
      user_id: target.id,
      credits,
      granted_by: userId,
    })
    if (insertError) {
      // The table does not exist until migration 0023 is applied live.
      const msg =
        /credit_grants/i.test(insertError.message) || insertError.code === '42P01'
          ? 'Additional tokens are not set up yet (migration 0023 has not been applied).'
          : insertError.message
      throw new HttpError(500, msg)
    }
    const loaded = await loadUsageForUser(adm, target.id)
    const twoTier = await balancesFor(adm, target.id, loaded, false)
    return {
      username: target.username,
      additionalGranted: twoTier.additionalGranted,
      additionalRemaining: twoTier.additionalRemaining,
    }
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
      return { ...usageResponse([], week, twoTierBalances({})), users: [], totals: { ...summarizeUsage([]), users: 0 } }
    }
    const profiles = check(await adm.from('profiles').select('id, username').in('id', userIds))
    const names = Object.fromEntries(profiles.map((p) => [p.id, p.username]))
    const agentIds = [...new Set(requests.map((r) => r.assigned_agent_id))]
    const agentProfiles = check(await adm.from('profiles').select('id, username').in('id', agentIds))
    const agentNames = Object.fromEntries(agentProfiles.map((p) => [p.id, p.username]))
    const grants = await loadGrantsTotals(adm, userIds)
    // One row per user, from (perAgent, totals, byWeek).
    const rowFor = (uid, perAgent, totals, byWeek) => {
      const twoTier = twoTierBalances({
        byWeek,
        weekCredits: totals.weekCredits,
        granted: grants.get(uid) ?? 0,
        // The admin is exempt from the cutoff (his own row included).
        isOwner: uid === userId,
      })
      return {
        userId: uid,
        username: names[uid] ?? 'Someone',
        agents: perAgent,
        totals,
        additionalGranted: twoTier.additionalGranted,
        additionalRemaining: twoTier.additionalRemaining,
        outOfCredits: twoTier.outOfCredits,
      }
    }
    // Try the cached ledger first (one small query per user, no message
    // content). If the ledger is not available yet (migration 0025 not
    // applied live) or any ledger read fails, fall back to the
    // full-history computation below — same numbers, just slower.
    let users = null
    try {
      users = []
      for (const uid of userIds) {
        const loaded = await loadUsageFromLedger(adm, uid)
        users.push(rowFor(uid, loaded.perAgent, loaded.totals, loaded.weekly.byWeek))
      }
    } catch (err) {
      console.error('usage ledger read (falling back to history)', err.message)
      users = null
    }
    if (!users) {
      // Full-history fallback (the pre-ledger computation, unchanged):
      // every DM row, counted per user from the approved pairs.
      const rows = await fetchAll(adm, () =>
        adm.from('messages').select(MESSAGE_COLUMNS).is('group_id', null).not('recipient_id', 'is', null),
      )
      users = userIds.map((uid) => {
        const agentIdsForUser = pairsByUser.get(uid)
        const perAgent = agentIdsForUser.map((agentId) => ({
          agentId,
          agentUsername: agentNames[agentId] ?? 'AI agent',
          ...computePairUsage(rows, uid, agentId, week.weekStart),
        }))
        const totals = summarizeUsage(perAgent)
        const { byWeek } = weeklyCreditTotals(rows, uid, agentIdsForUser)
        return rowFor(uid, perAgent, totals, byWeek)
      })
    }
    users.sort((a, b) => b.totals.credits - a.totals.credits)
    const grand = summarizeUsage(users.map((u) => u.totals))
    return { ...usageResponse([], week, twoTierBalances({})), users, totals: { ...grand, users: users.length } }
  },
})

export default own
