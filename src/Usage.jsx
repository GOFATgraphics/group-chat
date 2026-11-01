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
  range: 'Messages 1 to 1552',
  updated: '2026-11-01',
  currency: 'USD',
  adam: {
    totalCost: 4.81,
    totalTokens: 2034058,
    replies: 571,
    chatCost: 0.61,
    chatTokens: 1416008,
    reasoningCost: 3.44,
    reasoningTokens: 343600,
    toolCost: 0.32,
    toolCalls: 3227,
    toolTokens: 161350,
    transcribeCost: 0.01,
    transcribeTokens: 7100,
    tradeCost: 0.42,
    tradeTokens: 106000,
    tradeRefs: 53,
    voiceOutputs: 42,
    voiceOutputSeconds: 573.9,
    incomingVoice: 71,
    incomingVoiceSeconds: 1288.2,
  },
  ali: {
    totalCost: 3.77,
    totalTokens: 1464123,
    replies: 372,
    chatCost: 0.86,
    chatTokens: 1031873,
    reasoningCost: 2.34,
    reasoningTokens: 234000,
    toolCost: 0.21,
    toolCalls: 2111,
    toolTokens: 105550,
    transcribeCost: 0.01,
    transcribeTokens: 6700,
    tradeCost: 0.34,
    tradeTokens: 86000,
    tradeRefs: 43,
    voiceOutputs: 19,
    voiceOutputSeconds: 497.8,
    incomingVoice: 67,
    incomingVoiceSeconds: 1140.1,
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

export function Usage({ data = USAGE_DATA, onBack }) {
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
