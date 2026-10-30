// The whole HTTP API as one Vercel function (the Hobby plan allows at most 12
// functions per deployment). vercel.json rewrites every /api/... path here as
// ?__route=<rest of the path>, and this file hands the request to the matching
// handler in server/routes/. Public URLs are unchanged.

import root from '../server/routes/root.js'
import login from '../server/routes/login.js'
import refresh from '../server/routes/refresh.js'
import me from '../server/routes/me.js'
import members from '../server/routes/members.js'
import messages from '../server/routes/messages.js'
import message from '../server/routes/message.js'
import reactions from '../server/routes/reactions.js'
import read from '../server/routes/read.js'
import file from '../server/routes/file.js'
import webhook from '../server/routes/webhook.js'
import typing from '../server/routes/typing.js'
import bot from '../server/routes/bot.js'
import push from '../server/routes/push.js'
import pushKey from '../server/routes/push-key.js'
import call from '../server/routes/call.js'
import presence from '../server/routes/presence.js'
import tools from '../server/routes/tools.js'
import avatar from '../server/routes/avatar.js'
import { projects, project, subcollection, item } from '../server/routes/projects.js'

const exact = {
  '': root,
  login,
  refresh,
  me,
  members,
  messages,
  reactions,
  read,
  file,
  webhook,
  typing,
  bot,
  push,
  'push/key': pushKey,
  'call/start': call.start,
  'call/token': call.token,
  'call/check': call.check,
  'ai/check': call.check,
  presence,
  avatar,
  search: tools.search,
  pins: tools.pins,
  polls: tools.polls,
  'polls/vote': tools.vote,
  'polls/choice': tools.choice,
  notes: tools.notes,
  schedule: tools.schedule,
  tasks: tools.tasks,
}

export default async function handler(req, res) {
  const query = { ...(req.query ?? {}) }
  let path = query.__route
  delete query.__route
  if (path == null) {
    // Called without the rewrite (e.g. GET /api): read the path from the URL.
    path = new URL(req.url ?? '/api', 'http://x').pathname.replace(/^\/api\/?/, '')
  }
  path = String(Array.isArray(path) ? path.join('/') : path).replace(/^\/+|\/+$/g, '')
  req.query = query

  const direct = exact[path]
  if (direct) return direct(req, res)

  if (path === 'projects') return projects(req, res)

  const proj = path.match(/^projects\/([^/]+)$/)
  if (proj) {
    req.query = { ...query, id: proj[1] }
    return project(req, res)
  }

  const sub = path.match(/^projects\/([^/]+)\/([^/]+)$/)
  if (sub) {
    req.query = { ...query, id: sub[1], kind: sub[2] }
    return subcollection(req, res)
  }

  const row = path.match(/^projects\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (row) {
    req.query = { ...query, id: row[1], kind: row[2], rowId: row[3] }
    return item(req, res)
  }

  const one = path.match(/^messages\/([^/]+)$/)
  if (one) {
    req.query = { ...query, id: one[1] }
    return message(req, res)
  }

  res.setHeader('Access-Control-Allow-Origin', '*')
  return res.status(404).json({ error: `No API endpoint at /api/${path}. See /agent-api.md.` })
}
