import { useEffect, useState } from 'react'

// "My usage" — the Settings sheet section.
// Fetches GET /api/usage with the signed-in session token. The numbers
// are ESTIMATES counted from chat text (see server/usage.js): the agents
// run their own Muse, so the app cannot see their real token usage.
//
// VISIBILITY (Ahmad, 8 Nov 2026 — REVERSING the earlier "each user sees
// their own usage" rule): ONLY the admin (Mubarak, the owner) sees usage
// numbers at all. Regular users see ONLY the plan card shell — "Free
// plan", "Weekly usage resets on <next Monday>", "Additional tokens" +
// "Never expires", and the "Upgrade" link — with NO figures, NO stats
// block, NO per-agent table, NO voice line. The shell DOES show the two
// blue progress bars (restored 8 Nov 2026 — the bars are part of the
// design Ahmad asked for): their widths come from GET /api/usage/bars,
// which returns ONLY the two 0–100 ratios, so no numbers ever reach a
// non-owner's browser. The owner sees everything as before. `isOwner`
// defaults to false (fail closed): numbers are hidden unless ownership
// is known.
//
// UI rule (Ahmad, 8 Nov 2026): numbers only, no explanatory paragraphs.
// The card, totals, per-agent table and the voice line carry short labels
// ("credits used", "tokens · 62 in / 1,574 out", "estimated cost"); the
// one-word "estimated" on the cost is the only qualifier. Do NOT add
// paragraphs explaining the rates, the estimate, the bars, or the
// additional-tokens figure — they were removed at the user's request.
//
// The card is styled like the screenshot Ahmad sent (8 Nov 2026): a dark
// rounded card with a "Free plan" row (weekly usage, reset date, blue
// progress bar), an "Additional tokens" row (all-time total, "Never
// expires", bar), a divider and a blue "Upgrade" link. Only REAL numbers
// from the messages table are shown — never the screenshot's numbers
// (15%, 2B tokens, 15 Nov were the other app's data). The reset date is
// the next Monday, computed by the server.
//
// TWO-TIER MODEL (decided 8 Nov 2026 — this REVERSES the earlier
// "Just the look — show usage, no limit" decision): each user gets 20
// free credits per Mon–Sun week; any usage above that draws from their
// additional-tokens balance (granted by the admin only, never expires,
// starts at 0). When both are used up, the agent tells the user they
// are out until Monday or until more tokens are added. The owner is
// exempt from the cutoff. The Free plan bar is this week vs the
// 20-credit limit; the Additional tokens bar is additional tokens used
// vs granted (0 when nothing granted). The figures stay admin-only;
// the bars are ratios only, shown to everyone.

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US')
}

function fmtCredits(c) {
  const v = Number(c ?? 0)
  return v < 10 ? v.toFixed(2) : v.toFixed(0)
}

function fmtMoney(usd) {
  const v = Number(usd ?? 0)
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`
}

function fmtMinutes(min) {
  const v = Number(min ?? 0)
  return v < 1 ? `${Math.round(v * 60)} sec` : `${v.toFixed(1)} min`
}

// Next Monday's label ("9 Nov"), computed client-side in UTC — the same
// rule as server/usage.js weekBounds(). Used by the non-owner shell, which
// renders without an API call and therefore has no server resetLabel.
function nextMondayLabel(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  // Monday = 1 (Sunday = 0): days until next Monday (always 1–7 ahead).
  const daysAhead = ((8 - d.getUTCDay()) % 7) || 7
  d.setUTCDate(d.getUTCDate() + daysAhead)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

// The summary card + per-agent breakdown, pure (no fetching) so it can be
// rendered in tests with fixture data. For a non-owner, `data` is null and
// only the plan card shell renders — no figures, no stats, no table, no
// voice line — but WITH the two progress bars, whose widths come from the
// `bars` prop ({ weekBarPct, additionalBarPct }, 0–100 ratios only, fetched
// from GET /api/usage/bars). `bars` null means "not loaded yet": the bar
// tracks still render, with a 0-width fill, so the card never shifts.
export function MyUsageCard({ data, isOwner = false, bars = null }) {
  const [upgradeNote, setUpgradeNote] = useState(false)
  if (!isOwner) {
    const weekBarPct = bars?.weekBarPct ?? 0
    const additionalBarPct = bars?.additionalBarPct ?? 0
    return (
      <div>
        <div className="myusage-card" aria-label="My usage summary">
          <div className="myusage-row">
            <div className="myusage-row-top">
              <span className="myusage-title">Free plan</span>
            </div>
            <p className="myusage-sub">Weekly usage resets on {nextMondayLabel()}</p>
            <div className="myusage-bar" role="progressbar" aria-label="This week's usage" aria-valuenow={Math.round(weekBarPct)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${weekBarPct}%` }} />
            </div>
          </div>

          <div className="myusage-row">
            <div className="myusage-row-top">
              <span className="myusage-title">Additional tokens</span>
            </div>
            <p className="myusage-sub">Never expires</p>
            <div className="myusage-bar" role="progressbar" aria-label="Additional tokens used" aria-valuenow={Math.round(additionalBarPct)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${additionalBarPct}%` }} />
            </div>
          </div>

          <div className="myusage-divider" />
          <button
            type="button"
            className="myusage-upgrade"
            onClick={() => setUpgradeNote(true)}
          >
            Upgrade
          </button>
          {upgradeNote && <p className="myusage-coming">Coming soon.</p>}
        </div>
      </div>
    )
  }
  const totals = data.totals
  const week = data.week
  const freeWeeklyCredits = data.freeWeeklyCredits ?? 20
  const weekBarPct = totals.weekBarPct ?? 0
  // Additional tokens bar: additional tokens used vs granted.
  const additionalBarPct = totals.additionalBarPct ?? 0
  return (
    <div>
      <div className="myusage-card" aria-label="My usage summary">
        <div className="myusage-row">
          <div className="myusage-row-top">
            <span className="myusage-title">Free plan</span>
            <span className="myusage-pct">{fmtCredits(totals.weekCredits)} / {freeWeeklyCredits} credits this week</span>
          </div>
          <p className="myusage-sub">Weekly usage resets on {week.resetLabel}</p>
          <div className="myusage-bar" role="progressbar" aria-label="This week's usage" aria-valuenow={Math.round(weekBarPct)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${weekBarPct}%` }} />
          </div>
        </div>

        <div className="myusage-row">
          <div className="myusage-row-top">
            <span className="myusage-title">Additional tokens</span>
            <span className="myusage-pct">{fmtCredits(data.additionalRemaining ?? 0)} credits left</span>
          </div>
          <p className="myusage-sub">Never expires</p>
          <div className="myusage-bar" role="progressbar" aria-label="Additional tokens used" aria-valuenow={Math.round(additionalBarPct)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${additionalBarPct}%` }} />
          </div>
        </div>

        <div className="myusage-divider" />
        <button
          type="button"
          className="myusage-upgrade"
          onClick={() => setUpgradeNote(true)}
        >
          Upgrade
        </button>
        {upgradeNote && <p className="myusage-coming">Coming soon.</p>}
      </div>

      <div className="myusage-totals" aria-label="Totals">
        <div>
          <strong>{fmtCredits(totals.credits)}</strong>
          <span>credits used</span>
        </div>
        <div>
          <strong>{fmt(totals.totalTokens)}</strong>
          <span>tokens · {fmt(totals.inputTokens)} in / {fmt(totals.outputTokens)} out</span>
        </div>
        <div>
          <strong>{fmtMoney(totals.costUsd)}</strong>
          <span>estimated cost</span>
        </div>
      </div>

      {totals.voiceNotes > 0 && (
        <p className="myusage-voice">
          Voice: {totals.voiceNotes} voice {totals.voiceNotes === 1 ? 'note' : 'notes'} · {fmtMinutes(totals.voiceMinutes)}
        </p>
      )}

      {data.agents.length > 0 ? (
        <table className="usage-table myusage-breakdown">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col" className="num">Input</th>
              <th scope="col" className="num">Output</th>
              <th scope="col" className="num">Credits</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.agentId}>
                <td>{a.agentUsername}</td>
                <td className="num">{fmt(a.inputTokens)}</td>
                <td className="num">{fmt(a.outputTokens)}</td>
                <td className="num cost">{fmtCredits(a.credits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="myusage-empty">No AI agent chats yet.</p>
      )}
    </div>
  )
}

export default function MyUsage({ token, isOwner = false }) {
  const [data, setData] = useState(null)
  const [bars, setBars] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) {
      if (isOwner) setError('You are not signed in. Sign in again to see your usage.')
      return
    }
    let cancelled = false
    setError('')
    // Non-owners fetch ONLY the bar ratios (GET /api/usage/bars returns
    // { weekBarPct, additionalBarPct } and nothing else), so the two bars can
    // show without any figures ever reaching their browser. If the fetch
    // fails, the bars stay at 0 — the tracks still render.
    const path = isOwner ? '/api/usage' : '/api/usage/bars'
    fetch(path, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || 'Could not load usage.')
        return json
      })
      .then((json) => {
        if (!cancelled) {
          if (isOwner) setData(json)
          else setBars(json)
        }
      })
      .catch((err) => {
        if (!cancelled && isOwner) setError(err.message || 'Could not load usage.')
      })
    return () => {
      cancelled = true
    }
  }, [token, isOwner])

  return (
    <section className="myusage" aria-label="My usage">
      <div className="myusage-head">My usage</div>
      {!isOwner ? (
        <MyUsageCard data={null} isOwner={false} bars={bars} />
      ) : error ? (
        <p className="setting-note error">{error}</p>
      ) : !data ? (
        <p className="setting-note muted">Loading usage…</p>
      ) : (
        <MyUsageCard data={data} isOwner bars={null} />
      )}
    </section>
  )
}
