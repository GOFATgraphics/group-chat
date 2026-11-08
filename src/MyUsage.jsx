import { useEffect, useState } from 'react'

// "My usage" — the Settings sheet section showing what this user has used
// with their AI agent(s). Fetches GET /api/usage with the signed-in
// session token. The numbers are ESTIMATES counted from chat text (see
// server/usage.js): the agents run their own Muse, so the app cannot see
// their real token usage — the screen says so, it is not a bill.
//
// The card is styled like the screenshot Ahmad sent (8 Nov 2026): a dark
// rounded card with a "Free plan" row (weekly usage, reset date, blue
// progress bar), an "Additional tokens" row (all-time total, "Never
// expires", bar), a divider and a blue "Upgrade" link. Only REAL numbers
// from the messages table are shown — never the screenshot's numbers
// (15%, 2B tokens, 15 Nov were the other app's data). The reset date is
// the next Monday, computed by the server.
//
// NO LIMIT (decided 8 Nov 2026: "Just the look — show usage, no limit"):
// there is no weekly allowance and no "% used" anywhere. The Free plan
// bar is this week scaled against the user's own busiest week so far;
// the Additional tokens bar is this week's share of the all-time total.
// Neither bar implies a cap.

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

// The summary card + per-agent breakdown, pure (no fetching) so it can be
// rendered in tests with fixture data.
export function MyUsageCard({ data }) {
  const [upgradeNote, setUpgradeNote] = useState(false)
  const totals = data.totals
  const week = data.week
  const weekBarPct = totals.weekBarPct ?? 0
  // Additional tokens bar: this week's share of the all-time total.
  const allTimeBarPct =
    totals.totalTokens > 0 ? Math.max(0, Math.min(100, (totals.weekTokens / totals.totalTokens) * 100)) : 0
  return (
    <div>
      <div className="myusage-card" aria-label="My usage summary">
        <div className="myusage-row">
          <div className="myusage-row-top">
            <span className="myusage-title">Free plan</span>
            <span className="myusage-pct">{fmtCredits(totals.weekCredits)} credits this week</span>
          </div>
          <p className="myusage-sub">Weekly usage resets on {week.resetLabel}</p>
          <div className="myusage-bar" role="progressbar" aria-label="This week's usage compared with your busiest week so far" aria-valuenow={Math.round(weekBarPct)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${weekBarPct}%` }} />
          </div>
        </div>

        <div className="myusage-row">
          <div className="myusage-row-top">
            <span className="myusage-title">Additional tokens</span>
            <span className="myusage-pct">{fmt(totals.totalTokens)} tokens</span>
          </div>
          <p className="myusage-sub">Never expires</p>
          <div className="myusage-bar" role="progressbar" aria-label="This week's share of your all-time tokens" aria-valuenow={Math.round(allTimeBarPct)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${allTimeBarPct}%` }} />
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
        {upgradeNote && (
          <p className="setting-note muted">
            Upgrade isn&apos;t available yet — usage is display-only for now, nothing is limited or charged.
          </p>
        )}
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
        <p className="usage-note">
          Voice: {totals.voiceNotes} voice {totals.voiceNotes === 1 ? 'note' : 'notes'}, {fmtMinutes(totals.voiceMinutes)}.
          Transcription and the transcript&apos;s tokens are included in the numbers above.
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
        <p className="usage-note">
          No AI agent chats yet — once the Admin approves an agent for you, your usage will show here.
        </p>
      )}

      <p className="usage-note">
        Estimated from your chat text at {data.benchmark.model} rates (${data.benchmark.inputPerMillionUsd} in / $
        {data.benchmark.outputPerMillionUsd} out per 1M tokens); 1 credit = ${data.benchmark.creditUsd.toFixed(2)}.
        Your agents run their own AI, so this is an estimate, not a bill. Group chats, call transcripts and files are not counted.
      </p>
      <p className="usage-note">
        Additional tokens: the figure shown is your all-time token total — there is no extra token pack in v1.
        There is no usage limit: the bars compare this week with your busiest week so far (Free plan) and with your
        all-time total (Additional tokens). Nothing is limited or charged.
      </p>
    </div>
  )
}

export default function MyUsage({ token }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) {
      setError('You are not signed in. Sign in again to see your usage.')
      return
    }
    let cancelled = false
    setError('')
    fetch('/api/usage', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || 'Could not load usage.')
        return json
      })
      .then((json) => {
        if (!cancelled) setData(json)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load usage.')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <section className="myusage" aria-label="My usage">
      <div className="myusage-head">My usage</div>
      {error ? (
        <p className="setting-note error">{error}</p>
      ) : !data ? (
        <p className="setting-note muted">Loading usage…</p>
      ) : (
        <MyUsageCard data={data} />
      )}
    </section>
  )
}
