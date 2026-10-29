# Agent API

A small HTTP API so a bot or AI agent can take part in the group chat with its
own username and password, just like a person. It is served by the same Vercel
deployment as the app, under `/api`.

```
BASE = https://<your-app>.vercel.app/api
```

The agent is a normal chat member. Create its login in the Supabase SQL Editor:

```sql
select public.create_chat_user('assistant', 'a-long-random-password');
```

Its messages, photos, files and reactions show up for everyone like anyone else's.

## 1. Log in

```http
POST /api/login
Content-Type: application/json

{ "username": "assistant", "password": "a-long-random-password" }
```

```json
{
  "access_token": "eyJ...",
  "refresh_token": "v1.abc...",
  "expires_at": 1793300000,
  "user": { "id": "b0c1...", "username": "assistant" }
}
```

Send the access token on every other call:

```
Authorization: Bearer <access_token>
```

It lasts about an hour (`expires_at` is a Unix timestamp). Before it runs out, or
when any call returns **401**, swap the refresh token for a new pair:

```http
POST /api/refresh
{ "refresh_token": "v1.abc..." }
```

Each refresh token works once, so always keep the newest one. If refreshing
fails, just log in again.

## 2. Hear new messages instantly

Pick one of these. Both deliver a message to the agent within a fraction of a
second of it being sent.

### Option A: Webhook (fastest; needs a public HTTPS URL)

Register the URL once:

```http
PUT /api/webhook
Authorization: Bearer <access_token>
{ "url": "https://my-agent.example.com/chat-webhook" }
```

```json
{ "webhook": { "url": "https://my-agent.example.com/chat-webhook", "secret": "9f2c..." } }
```

From then on, every new message from **someone else** is POSTed to that URL
straight from the database, with no polling:

```http
POST /chat-webhook
Authorization: Bearer 9f2c...
Content-Type: application/json

{
  "type": "message.created",
  "message": {
    "id": 412,
    "user_id": "a1b2...",
    "username": "mom",
    "content": "Can someone check the form?",
    "attachment_path": "a1b2.../1793...-form.pdf",
    "attachment_name": "form.pdf",
    "attachment_type": "application/pdf",
    "attachment_size": 48211,
    "created_at": "2026-10-29T15:37:02.114Z"
  }
}
```

- Reject calls whose `Authorization` header is not `Bearer <your secret>`.
- Answer with any 2xx quickly (do the AI work after responding, or in the
  background). Deliveries time out after 5 seconds and are not retried.
- To download an attachment, call `GET /api/file?path=<attachment_path>`.
- `GET /api/webhook` shows the current URL and secret; `DELETE /api/webhook` stops deliveries.
  Changing the URL with `PUT` keeps the same secret.

### Option B: Long-polling (no public URL needed)

Ask for messages after the last id you have seen and let the request wait:

```http
GET /api/messages?after_id=412&wait=25&from_others=1
Authorization: Bearer <access_token>
```

The call returns **the moment** a new message arrives (about 0.3 s), or with an
empty list after 25 seconds. Call it again in a loop with the newest id.

## 3. Read messages

```http
GET /api/messages                 latest 50, oldest first
GET /api/messages?limit=200       up to 200
GET /api/messages?before_id=300   older history (page backwards)
GET /api/messages?after_id=412    only newer than 412
GET /api/messages/412             one message
```

```json
{
  "messages": [
    {
      "id": 412,
      "user_id": "a1b2...",
      "username": "mom",
      "text": "Can someone check the form?",
      "attachment": {
        "path": "a1b2.../1793...-form.pdf",
        "name": "form.pdf",
        "type": "application/pdf",
        "size": 48211,
        "url": "https://...supabase.co/storage/v1/object/sign/...  (valid 1 hour)"
      },
      "reactions": [{ "emoji": "👍", "user_id": "c3d4...", "username": "jackelyn" }],
      "created_at": "2026-10-29T15:37:02.114Z"
    }
  ]
}
```

`attachment` is `null` for plain text; `text` is `null` for a photo or file sent without a caption.

## 4. Send

Text:

```http
POST /api/messages
{ "text": "On it! I'll review the form now." }
```

A photo or file you have as bytes (keep it under about 3 MB because of Vercel's request size limit):

```json
{ "text": "Here's the chart", "file": { "name": "chart.png", "type": "image/png", "base64": "iVBORw0KGgo..." } }
```

A file at a public HTTPS link (up to 25 MB; the server downloads it):

```json
{ "text": "Summary attached", "file_url": "https://example.com/summary.pdf", "file_name": "summary.pdf" }
```

Images and videos display inline in the chat; anything else shows as a download card.
The response is `{ "message": { ...same shape as above } }`.

Delete one of the agent's own messages: `DELETE /api/messages/412`.

## 5. React (tapbacks)

```http
POST   /api/reactions   { "message_id": 412, "emoji": "❤️" }
DELETE /api/reactions   { "message_id": 412, "emoji": "❤️" }
```

The app's picker offers ❤️ 👍 👎 😂 ‼️ ❓ 🔥, but any emoji works.

## 6. Other

```http
GET /api/me        the agent's own profile
GET /api/members   everyone in the chat
GET /api/file?path=<attachment_path>          302 redirect to a download link
GET /api/file?path=<attachment_path>&json=1   { "url": "..." }
```

## Errors

Errors are JSON, for example `{ "error": "Access token expired. Call POST /api/refresh." }`.

| Status | Meaning |
| --- | --- |
| 400 | Bad input (missing text, bad URL, …) |
| 401 | Missing, expired or invalid token, or wrong password; refresh or log in again |
| 403 | Not allowed (for example, the account is not a chat member) |
| 404 | Message or file not found, or not yours to delete |
| 413 | File over 25 MB |

## Example: a fast reply loop in Python

No public URL needed. Replace `reply_to()` with your AI call.

```python
import time, requests

BASE = "https://<your-app>.vercel.app/api"
USERNAME, PASSWORD = "assistant", "a-long-random-password"

s = requests.Session()

def login():
    r = s.post(f"{BASE}/login", json={"username": USERNAME, "password": PASSWORD})
    r.raise_for_status()
    tokens = r.json()
    s.headers["Authorization"] = f"Bearer {tokens['access_token']}"
    return tokens

def call(method, path, **kw):
    global tokens
    r = s.request(method, f"{BASE}{path}", timeout=35, **kw)
    if r.status_code == 401:  # token expired: refresh (or log in) and retry once
        rr = s.post(f"{BASE}/refresh", json={"refresh_token": tokens["refresh_token"]})
        tokens = rr.json() if rr.ok else login()
        s.headers["Authorization"] = f"Bearer {tokens['access_token']}"
        r = s.request(method, f"{BASE}{path}", timeout=35, **kw)
    r.raise_for_status()
    return r.json()

def reply_to(message):
    return f"You said: {message['text']}"  # <- call your AI model here

tokens = login()
history = call("GET", "/messages")["messages"]
last_id = history[-1]["id"] if history else 0

while True:
    try:
        new = call("GET", f"/messages?after_id={last_id}&wait=25&from_others=1")["messages"]
    except requests.RequestException:
        time.sleep(2)
        continue
    for m in new:
        last_id = max(last_id, m["id"])
        if m["text"]:
            call("POST", "/messages", json={"text": reply_to(m)})
```

## Example: webhook receiver (Node)

```js
import express from 'express'

const SECRET = process.env.CHAT_WEBHOOK_SECRET // from PUT /api/webhook
const app = express()
app.use(express.json())

app.post('/chat-webhook', (req, res) => {
  if (req.headers.authorization !== `Bearer ${SECRET}`) return res.sendStatus(401)
  res.sendStatus(200) // acknowledge first, then think
  const { message } = req.body
  handle(message) // call your AI, then POST /api/messages with the reply
})

app.listen(3000)
```
