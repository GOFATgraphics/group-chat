// Token / credit usage estimates for the group chat (v1, 8 Nov 2026).
//
// What this is: the app counts usage from the *stored chat text* between a
// user and their assigned AI agent — the user's messages are input tokens,
// the agent's replies are output tokens. It is an ESTIMATE, labelled as
// such everywhere it is shown, not a bill from the AI company.
//
// Why only an estimate: the agents (Adam, Ali, Gauri, Anurag) are EXTERNAL
// — they reply through the agent API with gck_ personal API keys and run
// their own Muse. The app server never sees their real LLM usage: not the
// model they used, not the system prompt or history they sent, not the
// thinking tokens. Exact API usage is unobtainable here; the only honest
// number the app can produce is one counted from message text.
//
// Counting method: character estimate, ~4 characters per token. Measured
// accuracy is ±20–30% (English prose is ~5.2–5.4 chars/token, so ÷4
// overestimates prose by ~25–33%; code/JSON run ~2.7–4.3; Japanese ~1.7,
// so ÷4 underestimates it by ~55%). Claude 4.7+ tokenizers count roughly
// 30% more tokens for the same text. Never present these numbers as a bill.
// Upgrade path: Anthropic's free count_tokens API (input only) for exact
// counts of message text — still not the agent's real prompt.
//
// Pricing is the SINGLE source of truth for every $/credit number in the
// app (server routes and the Usage page both read it from here). Rates are
// the Claude Sonnet 5.5 benchmark from Anthropic's official pricing page,
// read 2026-11-08 ($2 in / $10 out per 1M tokens). Prices change fast —
// re-check the official page before relying on these. The agents' real
// models are unknown, so the $ figure is a benchmark, not a bill.
//
// Credit model (approved by Ahmad, 8 Nov 2026): Option A —
// 1 credit = $0.01 of real provider cost, metered by tokens
// (the GitHub Copilot model). Output tokens cost 5x input tokens, so a
// flat "1 credit = 1 token" would hide that; credits are priced from the
// token rates instead.
//
// TWO-TIER MODEL (decided by Ahmad, 8 Nov 2026 — this REVERSES the
// earlier "Just the look — show usage, no limit" decision). Each user
// gets FREE_WEEKLY_CREDITS free credits per Mon–Sun week; any usage
// above that draws from their additional-tokens balance (granted by the
// admin only, never expires, starts at 0). When both the free week and
// the additional tokens are used up, the agent tells the user they are
// out until Monday or until more tokens are added (see
// public/agent-api.md §6). The owner (Mubarak) is EXEMPT from the
// cutoff — his usage is still counted and shown, but he is never out
// of credits.
//
// FAIR-START RULE: two-tier excess counts only for weeks starting on or
// after FAIR_START_WEEK (Mon 2026-11-09). Usage before that was under
// the old display-only regime and must NOT consume additional tokens —
// nobody starts in debt. The "Free plan" bar is now this week vs the
// 20-credit limit; the "Additional tokens" bar is additional tokens
// used vs granted. Both bars are still shown to everyone (ratios only);
// the FIGURES stay admin-only.
//
// Counting and pricing are unchanged: credits at 1 credit = $0.01,
// Sonnet 5.5 $2 in / $10 out per 1M, character estimate from chat text,
// voice notes included, approved agent_requests DMs only.

export const FREE_WEEKLY_CREDITS = 20
// First Mon–Sun week the two-tier excess counts for (ISO week-start
// date, 'YYYY-MM-DD'). Weeks starting before this contribute 0 excess.
export const FAIR_START_WEEK = '2026-11-09'
//
// Voice notes (approved: included): audio minutes and text tokens are
// DIFFERENT meters. A voice note costs transcription (per minute) PLUS
// the transcript's tokens as input. A voice reply costs the reply's
// output tokens PLUS text-to-speech (per character). Durations come from
// messages.attachment_duration (seconds); a voice note with no recorded
// duration cannot be priced and is not counted.
//
// OUT of v1, by decision: group-chat messages (addressed to the whole
// group, not attributable to one user), call transcripts (call_duration
// is set — the transcript is saved as one message from the caller
// containing BOTH sides' speech, so counting it as user input would be
// wrong), and file contents (only name/type/size are stored).

export const PRICING = {
  // Benchmark model for the $ estimate (same benchmark the Usage page
  // already used). The agents' real models are unknown.
  benchmarkModel: 'Claude Sonnet 5.5',
  inputPerMillionUsd: 2, // $2 per 1M input tokens
  outputPerMillionUsd: 10, // $10 per 1M output tokens
  // 1 credit = $0.01 of provider cost (Option A).
  creditUsd: 0.01,
  // Transcription: gpt-transcribe $0.0045/min. (whisper-1 was $0.006/min
  // but was deprecated 26 Aug 2026 and is removed 26 Feb 2027.)
  transcriptionPerMinuteUsd: 0.0045,
  // Text-to-speech: tts-1 $15 per 1M characters.
  ttsPerMillionCharsUsd: 15,
  // Estimate constants (see header for accuracy limits).
  charsPerToken: 4,
  // Spoken English runs ~130–150 words/min ≈ ~200 tokens/min.
  transcriptTokensPerMinute: 200,
  // ~150 words/min at ~5.5 chars/word ≈ 850 characters/min of speech.
  ttsCharsPerMinute: 850,
}

// --- Token estimate -------------------------------------------------------

export function estimateTextTokens(text) {
  if (!text) return 0
  const chars = String(text).length
  if (!chars) return 0
  // ceil so a short "Hi" is 1 token, not 0.
  return Math.ceil(chars / PRICING.charsPerToken)
}

// --- Weekly cycle ---------------------------------------------------------
// Weekly cycle is Monday 00:00 UTC to the next Monday 00:00 UTC
// ("Weekly usage resets on …" in the UI is the next Monday).

// The Monday 00:00 UTC starting the week that `date` falls in.
export function weekStartOf(date) {
  const d = new Date(date)
  const day = d.getUTCDay() // 0 = Sunday … 6 = Saturday
  const daysSinceMonday = (day + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday))
}

export function weekBounds(now = new Date()) {
  const weekStart = weekStartOf(now)
  const nextMonday = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)
  return {
    weekStart,
    nextMonday,
    // e.g. "9 Nov" — computed, never hardcoded.
    resetLabel: nextMonday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  }
}

// --- Per-message counting -------------------------------------------------
// A message row from public.messages. Returns null when the message is
// out of scope for usage (group chat, call transcript, or not part of
// this (user, agent) DM pair). Otherwise the usage it contributes.

export function countMessage(m, userId, agentId) {
  if (!m || m.call_duration != null) return null // call transcript: both sides in one row
  if (m.recipient_id == null || m.group_id != null) return null // group chat
  const fromUser = m.user_id === userId && m.recipient_id === agentId
  const fromAgent = m.user_id === agentId && m.recipient_id === userId
  if (!fromUser && !fromAgent) return null

  const textTokens = estimateTextTokens(m.content)
  const durationSec = Number(m.attachment_duration)
  const isVoice =
    (m.attachment_type ?? '').startsWith('audio/') && Number.isFinite(durationSec) && durationSec > 0
  const minutes = isVoice ? durationSec / 60 : 0
  // Transcript tokens (~200/min) count as input for a note the user sent,
  // as output for a spoken reply from the agent.
  const voiceTokens = isVoice ? Math.round(minutes * PRICING.transcriptTokensPerMinute) : 0
  const inputTokens = fromUser ? textTokens + voiceTokens : 0
  const outputTokens = fromAgent ? textTokens + voiceTokens : 0
  const transcriptionUsd = fromUser && isVoice ? minutes * PRICING.transcriptionPerMinuteUsd : 0
  const ttsChars = fromAgent && isVoice ? Math.round(minutes * PRICING.ttsCharsPerMinute) : 0
  const ttsUsd = (ttsChars * PRICING.ttsPerMillionCharsUsd) / 1e6
  const costUsd =
    (inputTokens * PRICING.inputPerMillionUsd) / 1e6 +
    (outputTokens * PRICING.outputPerMillionUsd) / 1e6 +
    transcriptionUsd +
    ttsUsd
  return {
    messages: 1,
    inputTokens,
    outputTokens,
    voiceMinutes: minutes,
    voiceNotes: isVoice ? 1 : 0,
    costUsd,
    credits: costUsd / PRICING.creditUsd,
  }
}

const ZERO = () => ({ messages: 0, inputTokens: 0, outputTokens: 0, voiceMinutes: 0, voiceNotes: 0, costUsd: 0, credits: 0 })

function addInto(acc, part) {
  acc.messages += part.messages
  acc.inputTokens += part.inputTokens
  acc.outputTokens += part.outputTokens
  acc.voiceMinutes += part.voiceMinutes
  acc.voiceNotes += part.voiceNotes
  acc.costUsd += part.costUsd
  acc.credits += part.credits
  return acc
}

// Usage for ONE (user, agent) pair, from that DM's message rows.
// weekStart: Date from weekBounds() — messages on/after it count toward
// this week's totals too.
export function computePairUsage(rows, userId, agentId, weekStart) {
  const all = ZERO()
  const week = ZERO()
  for (const m of rows) {
    const part = countMessage(m, userId, agentId)
    if (!part) continue
    addInto(all, part)
    if (weekStart && m.created_at && new Date(m.created_at) >= weekStart) addInto(week, part)
  }
  return {
    inputTokens: all.inputTokens,
    outputTokens: all.outputTokens,
    totalTokens: all.inputTokens + all.outputTokens,
    voiceMinutes: all.voiceMinutes,
    voiceNotes: all.voiceNotes,
    messages: all.messages,
    costUsd: all.costUsd,
    credits: all.credits,
    weekTokens: week.inputTokens + week.outputTokens,
    weekCredits: week.credits,
    weekMessages: week.messages,
  }
}

// Combine per-agent results into totals (same shape, no agent fields).
export function summarizeUsage(perAgent) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    voiceMinutes: 0,
    voiceNotes: 0,
    messages: 0,
    costUsd: 0,
    credits: 0,
    weekTokens: 0,
    weekCredits: 0,
    weekMessages: 0,
  }
  for (const a of perAgent) {
    totals.inputTokens += a.inputTokens
    totals.outputTokens += a.outputTokens
    totals.totalTokens += a.totalTokens
    totals.voiceMinutes += a.voiceMinutes
    totals.voiceNotes += a.voiceNotes
    totals.messages += a.messages
    totals.costUsd += a.costUsd
    totals.credits += a.credits
    totals.weekTokens += a.weekTokens
    totals.weekCredits += a.weekCredits
    totals.weekMessages += a.weekMessages
  }
  return totals
}

// Credits per Mon–Sun week for one user across all their approved agents,
// plus the busiest week's credits. The per-week map is what
// twoTierBalances() uses for the fair-start excess sum; the "Free plan"
// bar is now scaled against the 20-credit limit, not the busiest week.
export function weeklyCreditTotals(rows, userId, agentIds) {
  const byWeek = {}
  for (const m of rows) {
    if (!m || m.call_duration != null || m.recipient_id == null || m.group_id != null) continue
    let agentId = null
    if (m.user_id === userId && agentIds.includes(m.recipient_id)) agentId = m.recipient_id
    else if (agentIds.includes(m.user_id) && m.recipient_id === userId) agentId = m.user_id
    else continue
    const part = countMessage(m, userId, agentId)
    if (!part || !m.created_at) continue
    const key = weekStartOf(new Date(m.created_at)).toISOString().slice(0, 10)
    byWeek[key] = (byWeek[key] ?? 0) + part.credits
  }
  return { byWeek, busiestWeekCredits: Math.max(0, ...Object.values(byWeek)) }
}

// --- Bar ratios (visuals only, no absolute values) -----------------------
// The two progress bars in the "My usage" card, as 0–100 ratios —
// nothing a bar width could be read back from as a number. Both bars
// are shown to EVERYONE (decided 8 Nov 2026: the bars are part of the
// design; only the figures are admin-only):
//   weekBarPct        — this week's credits vs the 20-credit free limit.
//   additionalBarPct  — additional tokens used vs granted (0 when
//                       nothing has been granted — there is no balance
//                       to show a share of).
// A ratio of 0 means no usage to compare (no credits this week / no
// grants), never a fake or fixed width.
export function barRatios(twoTier) {
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v * 100) / 100))
  const weekBarPct = clamp(((twoTier.weekCredits ?? 0) / FREE_WEEKLY_CREDITS) * 100)
  const additionalBarPct =
    (twoTier.additionalGranted ?? 0) > 0
      ? clamp(((twoTier.additionalUsed ?? 0) / twoTier.additionalGranted) * 100)
      : 0
  return { weekBarPct, additionalBarPct }
}

// --- Two-tier balances ----------------------------------------------------
// The single definition of the two-tier model, used by every endpoint
// and the UI. Inputs:
//   byWeek   — { 'YYYY-MM-DD' (Mon week start): credits } for the user,
//              from weeklyCreditTotals().
//   weekCredits — this week's credits (same number as byWeek for the
//              current week, passed in so callers need no date math).
//   granted  — the user's additional-tokens balance granted so far
//              (sum of their credit_grants rows; 0 when none / when the
//              table does not exist yet).
//   isOwner  — true for the admin (Mubarak): counted and shown, but
//              never out of credits.
// Returns the week's free split, the additional balance, and whether
// the user is out. additionalUsed is the excess ONLY from weeks
// starting on/after FAIR_START_WEEK — a heavy week before that date
// contributes 0 (fair-start rule: nobody starts in debt).
export function twoTierBalances({ byWeek = {}, weekCredits = 0, granted = 0, isOwner = false } = {}) {
  const weekFreeUsed = Math.min(weekCredits, FREE_WEEKLY_CREDITS)
  const weekFreeRemaining = Math.max(0, FREE_WEEKLY_CREDITS - weekCredits)
  let additionalUsed = 0
  for (const [weekStart, credits] of Object.entries(byWeek)) {
    if (weekStart < FAIR_START_WEEK) continue
    additionalUsed += Math.max(0, credits - FREE_WEEKLY_CREDITS)
  }
  const additionalGranted = Math.max(0, granted)
  const additionalRemaining = Math.max(0, additionalGranted - additionalUsed)
  const outOfCredits = !isOwner && weekFreeRemaining <= 0 && additionalRemaining <= 0
  return {
    freeWeeklyCredits: FREE_WEEKLY_CREDITS,
    weekCredits,
    weekFreeUsed,
    weekFreeRemaining,
    additionalGranted,
    additionalUsed,
    additionalRemaining,
    outOfCredits,
  }
}
