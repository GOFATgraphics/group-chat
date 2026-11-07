// server.js - Node entry point for running the group chat on Render.
//
// Why this file exists: the repo was built for Vercel, where api/index.js is
// one serverless function and Vercel serves the Vite build. Render runs a
// long-lived Node process instead, so this file does both jobs:
//   1. Serves the Vite build from dist/ (the frontend, SPA fallback).
//   2. Routes /api/* to the existing api/index.js handler, unchanged.
//
// No handler in api/ or server/routes/ is modified. This file only adapts
// a plain Node request/response to the shape those handlers already expect
// from Vercel: req.query, req.body, and res.status().json() / res.redirect().
//
// Start command for Render:  node server.js
// (package.json gets:  "start": "node server.js")

import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import apiHandler from './api/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DIST = resolve(__dirname, 'dist')
const PORT = Number(process.env.PORT || 3000)
const HOST = '0.0.0.0'

// Same limit as the app itself: server/lib.js MAX_FILE_BYTES is 50 MB, and
// the chat accepts files up to 50 MB. Anything bigger is rejected here,
// before the handler sees it, so a huge upload cannot eat the 512 MB box.
const MAX_BODY_BYTES = 50 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

// --- Vercel-shaped response -----------------------------------------------
// Node's ServerResponse has setHeader / writeHead / write / end, but not
// .status().json() or .redirect(), which the handlers use (server/lib.js
// route(), server/routes/file.js). Add them on top of the real response,
// so the handlers run exactly as they do on Vercel.
function adaptResponse(res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
    return res
  }
  // Vercel: res.redirect(status, url) or res.redirect(url)
  res.redirect = (code, url) => {
    if (typeof code === 'string') {
      url = code
      code = 302
    }
    res.writeHead(code, { Location: url })
    res.end()
    return res
  }
  res.sendStatus = (code) => {
    res.statusCode = code
    res.end(http.STATUS_CODES[code] || String(code))
    return res
  }
  return res
}

// Read the request body (JSON for POST/PUT/DELETE). Vercel gives handlers
// a parsed req.body; server/lib.js body() accepts an object, or a string
// it JSON-parses itself, so either form works. A body that is not valid
// JSON is passed through as a string, and body() answers 400 for it.
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body too large (over 50 MB)'), { status: 413 })
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost')
  // Vercel's rewrite turns /api/messages?after_id=1 into
  // /api?__route=messages&after_id=1. Rebuild that here: __route is the
  // path after /api/, everything else stays as query parameters.
  const route = url.pathname.replace(/^\/api\/?/, '')
  const query = Object.fromEntries(url.searchParams)
  query.__route = route
  req.query = query
  // Keep req.url as the browser sent it: api/index.js falls back to
  // parsing it when __route is missing (GET /api with no rewrite).
  try {
    req.body = await readBody(req)
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  adaptResponse(res)
  try {
    await apiHandler(req, res)
  } catch (err) {
    // Most handlers run through server/lib.js route(), which turns its
    // own errors into JSON. The SSE stream does not use that wrapper: it
    // throws its auth error before writing anything, so answer with the
    // status the error carries (401 for a missing key), not a bare 500.
    console.error('api error', err)
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Internal error' })
    else if (!res.writableEnded) res.end()
  }
}

// --- Static frontend -------------------------------------------------------
function serveFile(res, file, method) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function handleStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'
  // Never let a crafted path escape dist/.
  const file = resolve(DIST, `.${rel}`)
  if (!file.startsWith(DIST + sep) && file !== DIST) {
    res.writeHead(403)
    return res.end('Forbidden')
  }
  if (existsSync(file) && statSync(file).isFile()) return serveFile(res, file, req.method)
  // SPA fallback: any other path is a client-side route, serve the app.
  // (API paths never reach here; they are handled above.)
  const index = join(DIST, 'index.html')
  if (existsSync(index)) return serveFile(res, index, req.method)
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found: dist/ is missing. Did the build run?')
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    handleApi(req, res).catch((err) => {
      console.error('api dispatch error', err)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal error' }))
    })
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: `Method ${req.method} not allowed` }))
  }
  handleStatic(req, res)
})

server.listen(PORT, HOST, () => {
  console.log(`group-chat listening on http://${HOST}:${PORT}`)
  if (!existsSync(join(DIST, 'index.html'))) {
    console.warn('WARNING: dist/index.html not found. Run `npm run build` first.')
  }
})
