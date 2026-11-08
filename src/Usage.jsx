// Usage screen, polished from GitHub dashboard patterns:
// - next-shadcn-dashboard-starter (Kiranism, 7,207 stars): KPI cards,
//   hairline borders, separate cards, one job per screen.
// - open-dashboard (ahpxex, 36 shadcn admin shapes): card + table,
//   label left, value right, muted notes that still pass contrast.
// - ui_ux_design skill: one type scale, one spacing scale, one radius
//   scale, visible focus, 44px touch targets, WCAG 2.2 AA contrast.
// Tokens are the app's own: --bg, --text, --fill, --separator, --blue.
// No new colours, no Tailwind (this app is plain CSS + Vite).
// Data is a static snapshot from the token estimator, not a live Muse
// billing feed. Muse does not report token usage per chat, so these
// numbers are a market-price comparison in USD, Claude Sonnet 5.5
// benchmark, with prompt caching. Refresh by re-running the estimator
// and updating USAGE_DATA below. Adam and Ali are on separate Muses.

export const USAGE_DATA = {
  range: 'Messages 1 to 2137',
  updated: '2026-11-02',
  currency: 'USD',
  adam: {
    totalCost: 6.8696,
    totalTokens: 2869413,
    replies: 796,
    chatCost: 0.8447,
    chatTokens: 1980963,
    reasoningCost: 4.9,
    reasoningTokens: 490000,
    toolCost: 0.4523,
    toolCalls: 4523,
    toolTokens: 226150,
    transcribeCost: 0.0166,
    transcribeTokens: 8300,
    tradeCost: 0.656,
    tradeTokens: 164000,
    tradeRefs: 82,
    voiceOutputs: 57,
    voiceOutputSeconds: 621.8,
    incomingVoice: 83,
    incomingVoiceSeconds: 1494.8,
  },
  ali: {
    totalCost: 5.1077,
    totalTokens: 1919051,
    replies: 473,
    chatCost: 1.112,
    chatTokens: 1315601,
    reasoningCost: 3.116,
    reasoningTokens: 311600,
    toolCost: 0.2715,
    toolCalls: 2715,
    toolTokens: 135750,
    transcribeCost: 0.0162,
    transcribeTokens: 8100,
    tradeCost: 0.592,
    tradeTokens: 148000,
    tradeRefs: 74,
    voiceOutputs: 22,
    voiceOutputSeconds: 539.3,
    incomingVoice: 81,
    incomingVoiceSeconds: 1318.5,
  },
}

function fmt(n) {
  return n.toLocaleString('en-US')
}

function Breakdown({ p }) {
  const rows = [
    ['Chat, prompt caching', p.chatTokens, p.chatCost],
    ['Reasoning, modelled', p.reasoningTokens, p.reasoningCost],
    [`Tool calls, ${fmt(p.toolCalls)} calls`, p.toolTokens, p.toolCost],
    ['Voice transcription overhead', p.transcribeTokens, p.transcribeCost],
    [`Trade work, ${p.tradeRefs} MCF refs`, p.tradeTokens, p.tradeCost],
  ]
  return (
    <table className="usage-table">
      <tbody>
        {rows.map(([label, tokens, cost]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="num">{fmt(tokens)}</td>
            <td className="num cost">${cost.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PersonCard({ name, note, p }) {
  return (
    <section className="usage-card" aria-label={`${name} usage`}>
      <div className="usage-card-head">
        <div>
          <h2>{name}</h2>
          <p className="usage-note">{fmt(p.replies)} replies</p>
        </div>
        <div className="usage-total">
          <strong>${p.totalCost.toFixed(2)}</strong>
          <span>{fmt(p.totalTokens)} tokens</span>
        </div>
      </div>
      <Breakdown p={p} />
      <p className="usage-note">
        Voice: {p.voiceOutputs} outputs, {p.voiceOutputSeconds} seconds. {p.incomingVoice} incoming voice notes, {p.incomingVoiceSeconds} seconds.
      </p>
      {note ? <p className="usage-note">{note}</p> : null}
    </section>
  )
}

function fmtMoney(n) {
  const v = Number(n ?? 0)
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`
}

// Live per-user totals for the admin (Mubarak). `admin` is null for
// everyone else — the section never renders for them. Totals only, no
// message content ever reaches this screen.
function AdminUsage({ admin }) {
  if (!admin) return null
  const { loading, error, data } = admin
  return (
    <section className="usage-card" aria-label="Everyone's usage">
      <div className="usage-card-head">
        <div>
          <h2>Everyone</h2>
          <p className="usage-note">Live totals from chat text, estimated at Sonnet 5.5 rates</p>
        </div>
      </div>
      {loading ? (
        <p className="usage-note">Loading everyone&apos;s usage…</p>
      ) : error ? (
        <p className="usage-note">{error}</p>
      ) : !data || !data.users.length ? (
        <p className="usage-note">No usage yet — nobody has chatted with an assigned agent.</p>
      ) : (
        <>
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col" className="num">Input</th>
                  <th scope="col" className="num">Output</th>
                  <th scope="col" className="num">Tokens</th>
                  <th scope="col" className="num">Credits</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">Voice</th>
                  <th scope="col" className="num">Msgs</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.userId}>
                    <td>{u.username}</td>
                    <td className="num">{fmt(u.totals.inputTokens)}</td>
                    <td className="num">{fmt(u.totals.outputTokens)}</td>
                    <td className="num">{fmt(u.totals.totalTokens)}</td>
                    <td className="num cost">{fmt(u.totals.credits)}</td>
                    <td className="num">{fmtMoney(u.totals.costUsd)}</td>
                    <td className="num">{u.totals.voiceMinutes < 1 ? `${Math.round(u.totals.voiceMinutes * 60)}s` : `${u.totals.voiceMinutes.toFixed(1)}m`}</td>
                    <td className="num">{fmt(u.totals.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="usage-note">
            {fmt(data.totals.users)} {data.totals.users === 1 ? 'user' : 'users'} · {fmt(data.totals.totalTokens)} tokens ·{' '}
            {fmt(data.totals.credits)} credits · {fmtMoney(data.totals.costUsd)} estimated. Totals only — no message content.
          </p>
        </>
      )}
    </section>
  )
}

export function Usage({ data = USAGE_DATA, onBack, admin = null }) {
  const adam = data.adam
  const ali = data.ali
  const combined = adam.totalCost + ali.totalCost
  return (
    <main className="project-page usage-page" aria-label="Usage">
      <header className="project-header usage-header">
        <button className="project-back" onClick={onBack} aria-label="Back to chats">
          &lsaquo; Back to chats
        </button>
        <h1>Usage</h1>
        <p className="usage-note">
          {data.range}, updated {data.updated}. Currency {data.currency}, market benchmark, not Muse billing.
        </p>
      </header>

      <AdminUsage admin={admin} />
      <section className="usage-kpis" aria-label="Totals">
        <div className="usage-kpi">
          <span className="usage-kpi-label">Adam</span>
          <strong>${adam.totalCost.toFixed(2)}</strong>
          <span>{fmt(adam.totalTokens)} tokens</span>
        </div>
        <div className="usage-kpi">
          <span className="usage-kpi-label">Ali, separate</span>
          <strong>${ali.totalCost.toFixed(2)}</strong>
          <span>{fmt(ali.totalTokens)} tokens</span>
        </div>
        <div className="usage-kpi">
          <span className="usage-kpi-label">Combined, for comparison</span>
          <strong>${combined.toFixed(2)}</strong>
          <span>Separate Muses, not one bill</span>
        </div>
      </section>

      <PersonCard name="Adam" p={adam} />
      <PersonCard
        name="Ali, separate"
        p={ali}
        note="Ali private chats with Mubarak and Mudassir are not included, Adam cannot see them. Ali reasoning and tool tokens use the same assumptions as Adam, they are not measured from Ali own Muse."
      />

      <p className="usage-note">
        Reasoning and tool framing are modelled, not measured by Muse. Voice durations are measured from single-message fetches. Refresh by re-running the estimator and updating USAGE_DATA.
      </p>
    </main>
  )
}

export default Usage
