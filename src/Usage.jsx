// Usage screen, mirroring ProjectsList. Data is a static snapshot from
// the token estimator, not a live Muse billing feed. Muse does not
// report token usage per chat, so these numbers are a market-price
// comparison in USD, Claude Sonnet 5.5 benchmark, with prompt caching.
// Refresh by re-running the estimator and updating USAGE_DATA below.
// Adam and Ali are on separate Muses, so their totals are separate,
// not one bill.

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

function Rows({ p }) {
  return (
    <tbody>
      <tr><td>Chat, prompt caching</td><td style={{ textAlign: 'right' }}>{fmt(p.chatTokens)}</td><td style={{ textAlign: 'right' }}>${p.chatCost.toFixed(2)}</td></tr>
      <tr><td>Reasoning, modelled</td><td style={{ textAlign: 'right' }}>{fmt(p.reasoningTokens)}</td><td style={{ textAlign: 'right' }}>${p.reasoningCost.toFixed(2)}</td></tr>
      <tr><td>Tool calls, {fmt(p.toolCalls)} calls</td><td style={{ textAlign: 'right' }}>{fmt(p.toolTokens)}</td><td style={{ textAlign: 'right' }}>${p.toolCost.toFixed(2)}</td></tr>
      <tr><td>Voice transcription overhead</td><td style={{ textAlign: 'right' }}>{fmt(p.transcribeTokens)}</td><td style={{ textAlign: 'right' }}>${p.transcribeCost.toFixed(2)}</td></tr>
      <tr><td>Trade work, {p.tradeRefs} MCF refs</td><td style={{ textAlign: 'right' }}>{fmt(p.tradeTokens)}</td><td style={{ textAlign: 'right' }}>${p.tradeCost.toFixed(2)}</td></tr>
    </tbody>
  )
}

export function Usage({ data = USAGE_DATA, onBack }) {
  const adam = data.adam
  const ali = data.ali
  return (
    <main className="project-page" aria-label="Usage">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={onBack}>Back to chats</button>
        <h1>Usage</h1>
      </div>
      <p>{data.range}, updated {data.updated}. Currency {data.currency}, market benchmark, not Muse billing. Adam and Ali are on separate Muses.</p>
      <section>
        <h2>Adam: ${adam.totalCost.toFixed(2)} - {fmt(adam.totalTokens)} tokens, {adam.replies} replies</h2>
        <table style={{ width: '100%' }}><Rows p={adam} /></table>
        <p>Voice: {adam.voiceOutputs} voice outputs, {adam.voiceOutputSeconds} seconds. {adam.incomingVoice} incoming voice notes, {adam.incomingVoiceSeconds} seconds.</p>
      </section>
      <section>
        <h2>Ali, separate: ${ali.totalCost.toFixed(2)} - {fmt(ali.totalTokens)} tokens, {ali.replies} replies</h2>
        <table style={{ width: '100%' }}><Rows p={ali} /></table>
        <p>Voice: {ali.voiceOutputs} voice outputs, {ali.voiceOutputSeconds} seconds. {ali.incomingVoice} incoming voice notes, {ali.incomingVoiceSeconds} seconds.</p>
        <p>Ali private chats with Mubarak and Mudassir are not included, Adam cannot see them. Ali reasoning and tool tokens use the same assumptions as Adam, they are not measured from Ali own Muse.</p>
      </section>
      <p>Reasoning and tool framing are modelled, not measured by Muse. Voice durations are measured from single-message fetches. Refresh by re-running the estimator and updating USAGE_DATA.</p>
    </main>
  )
}

export default Usage
