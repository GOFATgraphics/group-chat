import { useState } from 'react'
import { decideRequest, effectiveAgentId } from './agentRequests.js'

// Mubarak's detail sheet for one agent request. Same .sheet pattern as
// the other sheets in Chat.jsx (backdrop click closes, Cancel closes).
// Approve chooses the final agent — the requester's preferred agent is
// only a preference — and the welcome DM is sent by a DB trigger on
// approval, not from this sheet. Reassigning an already-approved
// request re-opens this sheet from the approved list.
export default function RequestSheet({ request, requester, aiAgents, Avatar, myId, onClose, onDecided }) {
  const [selectedAgent, setSelectedAgent] = useState(() => effectiveAgentId(request) ?? '')
  const [mode, setMode] = useState('decide')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const agentName = (id) => aiAgents.find((a) => a.id === id)?.username ?? 'an AI agent'
  const isReassign = request.status === 'approved'

  async function decide(status, agentId, rejectionReason) {
    setError('')
    setBusy(true)
    try {
      await decideRequest({ id: request.id, decidedBy: myId, status, agentId, reason: rejectionReason })
      onDecided()
      onClose()
    } catch (err) {
      setError(err.message ?? 'Could not save the decision. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Agent request" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <button className="sheet-cancel" onClick={onClose}>
            Cancel
          </button>
          <span className="sheet-title">{isReassign ? 'Reassign agent' : 'Agent request'}</span>
        </div>
        <div className="sheet-body">
          <div className="member-row">
            <Avatar name={requester?.username} src={requester?.avatar} />
            <span className="member-name">{requester?.username ?? 'Unknown user'}</span>
            <span className={`status-pill status-${request.status}`}>{request.status}</span>
          </div>
          <p>
            Preferred agent: <strong>{effectiveAgentId(request) ? agentName(effectiveAgentId(request)) : 'any available agent'}</strong>
          </p>
          {request.message && <p>“{request.message}”</p>}
          <p className="muted">
            Requested {new Date(request.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </p>

          {mode === 'decide' ? (
            <>
              <label>
                Assign agent
                <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
                  <option value="">Choose an agent…</option>
                  {aiAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.username}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                {isReassign
                  ? 'Changing the agent keeps this request approved; the user gets no second welcome message.'
                  : 'Approving sends Mubarak’s welcome message to the requester and the agent appears in their chats.'}
              </p>
              {error && <div className="error">{error}</div>}
              <div className="sheet-actions">
                <button className="primary" disabled={busy || !selectedAgent} onClick={() => decide('approved', selectedAgent, null)}>
                  {busy ? 'Saving…' : isReassign ? 'Reassign' : 'Approve'}
                </button>
                {!isReassign && (
                  <button className="secondary" onClick={() => setMode('reject')}>
                    Reject
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <label>
                Reason for rejection (optional)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={280}
                  rows={3}
                  placeholder="The requester will see this…"
                />
              </label>
              {error && <div className="error">{error}</div>}
              <div className="sheet-actions">
                <button className="primary" disabled={busy} onClick={() => decide('rejected', null, reason)}>
                  {busy ? 'Saving…' : 'Confirm rejection'}
                </button>
                <button className="secondary" onClick={() => setMode('decide')}>
                  Back
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
