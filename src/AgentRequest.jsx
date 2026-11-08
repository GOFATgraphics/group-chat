import { useState } from 'react'
import { hasActiveRequestFor, submitRequest, effectiveAgentId } from './agentRequests.js'

// The new-user home: shown after signup/login when the user has no
// approved AI agent and no AI DM history, instead of "No messages yet".
// Welcome copy, the AI agents, the request form, and the status of any
// request already made. Once the user has an approved agent they can
// start a chat with, and once they dismiss this screen, the normal
// group chat takes over.
// canBrowseGroup is false for a restricted (public-signup) user: there
// is no group chat for them to browse instead, so the button is hidden
// and a Sign out link is shown instead (otherwise a user waiting for
// approval would have no way out of this screen at all).
export default function AgentRequest({ me, myId, aiAgents, requests, Avatar, onStartChat, onBrowseGroup, onRequestSent, canBrowseGroup = true, onSignOut }) {
  const [preferred, setPreferred] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  const approved = requests.filter((r) => r.status === 'approved')
  const pending = requests.filter((r) => r.status === 'pending')
  const rejected = requests.filter((r) => r.status === 'rejected')

  const agentName = (id) => aiAgents.find((a) => a.id === id)?.username ?? 'an AI agent'
  const chosenCovered = preferred ? hasActiveRequestFor(requests, preferred) : hasActiveRequestFor(requests, null)

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await submitRequest({ requestedBy: myId, preferredAgentId: preferred || null, message })
      setSent(true)
      setMessage('')
      setPreferred('')
      onRequestSent?.()
    } catch (err) {
      setError(err.message ?? 'Could not send the request. Try again.')
    } finally {
      setBusy(false)
    }
  }

  // AgentRequest owns its form state; the parent reloads requests and
  // passes them back down through onRequestSent.
  return (
    <div className="agent-home">
      <h1>Welcome, {me?.username ?? 'friend'} 👋</h1>
      <p className="muted">
        This is your space to chat with an AI agent. Request one below and Mubarak, the admin, will approve your request
        and assign an agent to you. Once approved, the agent appears in your chats and you can talk to them directly.
      </p>

      <section>
        <h2>AI agents</h2>
        <ul className="member-list">
          {aiAgents.map((agent) => (
            <li key={agent.id} className="member-row">
              <Avatar name={agent.username} src={agent.avatar} />
              <span className="member-name">{agent.username}</span>
              <span className="ai-badge">AI</span>
              {approved.some((r) => r.assigned_agent_id === agent.id) && (
                <button className="link" onClick={() => onStartChat(agent.id)}>
                  Start chatting
                </button>
              )}
            </li>
          ))}
          {aiAgents.length === 0 && <li className="muted">No AI agents are set up yet — check back soon.</li>}
        </ul>
      </section>

      {approved.length > 0 && (
        <section>
          <h2>Your agents</h2>
          <ul className="request-list">
            {approved.map((r) => (
              <li key={r.id} className="request-row">
                <span className="status-pill status-approved">Approved</span>
                <span>{agentName(r.assigned_agent_id)} is ready to chat with you.</span>
                <button className="link" onClick={() => onStartChat(r.assigned_agent_id)}>
                  Start chatting
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section>
          <h2>Waiting for approval</h2>
          <ul className="request-list">
            {pending.map((r) => (
              <li key={r.id} className="request-row">
                <span className="status-pill status-pending">Pending</span>
                <span>
                  Request for {effectiveAgentId(r) ? agentName(effectiveAgentId(r)) : 'any available agent'}
                  {r.message ? ` — “${r.message}”` : ''} — Mubarak will review it soon.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rejected.length > 0 && (
        <section>
          <h2>Not approved</h2>
          <ul className="request-list">
            {rejected.map((r) => (
              <li key={r.id} className="request-row">
                <span className="status-pill status-rejected">Rejected</span>
                <span>
                  Request for {effectiveAgentId(r) ? agentName(effectiveAgentId(r)) : 'any available agent'}
                  {r.rejection_reason ? ` — ${r.rejection_reason}` : ''}. You can send a new request below.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Request an AI agent</h2>
        {sent && <p className="success">Request sent. Mubarak will review it and let you know.</p>}
        <form className="login-card request-form" onSubmit={onSubmit}>
          <label>
            Preferred agent (optional)
            <select value={preferred} onChange={(e) => setPreferred(e.target.value)}>
              <option value="">Let Mubarak choose</option>
              {aiAgents.map((agent) => (
                <option key={agent.id} value={agent.id} disabled={hasActiveRequestFor(requests, agent.id)}>
                  {agent.username}
                  {hasActiveRequestFor(requests, agent.id) ? ' — already requested' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            What do you need help with? (optional)
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={280}
              rows={3}
              placeholder="A short note for Mubarak…"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={busy || chosenCovered}>
            {chosenCovered ? 'Already requested' : busy ? 'Sending…' : 'Send request'}
          </button>
          <p className="muted">Mubarak (admin) can read chats in this app.</p>
        </form>
      </section>

      {canBrowseGroup ? (
        <button className="link" onClick={onBrowseGroup}>
          Browse the group chat instead
        </button>
      ) : (
        <button className="link" onClick={onSignOut}>
          Sign out
        </button>
      )}
    </div>
  )
}
