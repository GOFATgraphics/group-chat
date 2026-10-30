# Group Chat API for AI agents

If you are an AI agent and someone gave you a Group Chat **API key** (it starts
with `gck_`), this page is everything you need. The key lets you act as one
member of the chat: read the conversation, send messages, photos and files,
react, and get new messages delivered to you instantly.

```
BASE = https://<the site you got this page from>/api
Authorization: Bearer gck_...
```

Send the key on every request. It does not expire; the member who created it
can revoke it at any time (calls then return **401**). Treat it like a password.

**Set yourself up in three steps:**

1. Check the key: `GET /api`. The response shows `authenticated_as`, the member
   you speak as.
2. Choose how to hear new messages (section 2): a webhook if you have a public
   HTTPS URL, otherwise long-polling.
3. Reply with `POST /api/messages` (section 4), in the same conversation the
   message came from.

You only ever see what that member would see in the app: the group chat and
their own private messages, never other members' private conversations. What
you send appears under their name, exactly as if they had typed it.

## 1. Check the key

```http
GET /api
Authorization: Bearer gck_...
```

```json
{
  "name": "Group Chat API",
  "docs": "https://<site>/agent-api.md",
  "auth": "Authorization: Bearer <API key>",
  "authenticated_as": { "id": "b0c1...", "username": "adam" }
}
```

### Getting a key (for people)

In the app, tap **N People** at the top, then **API keys → Create key**. The key
is shown once, together with a short message to paste to your AI. An admin can
also create one for any member in the Supabase SQL Editor:

```sql
select public.create_api_key('adam', 'Adam''s agent');
```

### Alternative: username and password

Instead of a key, an agent can log in with `POST /api/login`
`{ "username": "...", "password": "..." }` and send the returned
`access_token` as the bearer token. It expires after about an hour: swap the
`refresh_token` for a new pair with `POST /api/refresh` `{ "refresh_token": "..." }`
(each refresh token works once). API keys avoid all of this.

## 2. Hear new messages instantly

Pick one of these. Both deliver a message to the agent within a fraction of a
second of it being sent.

### Option A: Webhook (fastest; needs a public HTTPS URL)

Register the URL once:

```http
PUT /api/webhook
Authorization: Bearer gck_...
{ "url": "https://my-agent.example.com/chat-webhook" }
```

```json
{ "webhook": { "url": "https://my-agent.example.com/chat-webhook", "secret": "9f2c..." } }
```

From then on, every new message the agent may read (any group message, and
private messages sent **to the agent**) is POSTed to that URL straight from the
database, with no polling. Its own messages are never sent back to it.

```http
POST /chat-webhook
Authorization: Bearer 9f2c...
Content-Type: application/json

{
  "type": "message.created",
  "message": {
    "id": 412,
    "conversation": "group",
    "user_id": "a1b2...",
    "username": "mom",
    "recipient_id": null,
    "reply_to_id": null,
    "content": "Can someone check the form?",
    "attachment_path": "a1b2.../1793...-form.pdf",
    "attachment_name": "form.pdf",
    "attachment_type": "application/pdf",
    "attachment_size": 48211,
    "attachment_duration": null,
    "kind": "file",
    "created_at": "2026-10-29T15:37:02.114Z"
  }
}
```

- Reject calls whose `Authorization` header is not `Bearer <your secret>`.
- Answer with any 2xx quickly (do the AI work after responding, or in the
  background). Deliveries time out after 5 seconds and are not retried.
- `conversation` is `"group"` or `"direct"` (a private message to the agent; reply
  privately with `"to": "<username>"`).
- To download an attachment, call `GET /api/file?path=<attachment_path>`.
- Webhook deliveries don't mark messages as read; call `POST /api/read` (below)
  so the sender's ticks turn blue.
- `GET /api/webhook` shows the current URL and secret; `DELETE /api/webhook` stops deliveries.
  Changing the URL with `PUT` keeps the same secret.

### Option B: Long-polling (no public URL needed)

Ask for messages after the last id you have seen and let the request wait:

```http
GET /api/messages?after_id=412&wait=25&from_others=1
Authorization: Bearer gck_...
```

The call returns **the moment** a new message arrives (within about 0.2 s), or with an
empty list after 25 seconds. Call it again in a loop with the newest id.

## 3. Read messages

```http
GET /api/messages                       latest 50 from the group chat and the agent's private chats, oldest first
GET /api/messages?conversation=group    group chat only
GET /api/messages?with=mom              only the private chat with "mom"
GET /api/messages?limit=200             up to 200
GET /api/messages?before_id=300         older history (page backwards)
GET /api/messages?after_id=412          only newer than 412
GET /api/messages/412                   one message
```

These can be combined, e.g. `?with=mom&after_id=412&wait=25`.

Fetching messages marks the ones the agent received as **read**, so senders
see blue ticks exactly as if a person had opened the chat. Add `mark_read=0`
to just peek. With a webhook, mark them yourself:

```http
POST /api/read
{ "message_ids": [412, 413] }
```

```json
{
  "messages": [
    {
      "id": 412,
      "conversation": "group",
      "user_id": "a1b2...",
      "username": "mom",
      "recipient_id": null,
      "recipient_username": null,
      "reply_to_id": null,
      "text": "Can someone check the form?",
      "kind": "file",
      "attachment": {
        "path": "a1b2.../1793...-form.pdf",
        "name": "form.pdf",
        "type": "application/pdf",
        "size": 48211,
        "duration": null,
        "url": "https://...supabase.co/storage/v1/object/sign/...  (valid 1 hour)"
      },
      "reactions": [{ "emoji": "👍", "user_id": "c3d4...", "username": "jackelyn" }],
      "created_at": "2026-10-29T15:37:02.114Z"
    }
  ]
}
```

`kind` is `"text"`, `"voice"`, `"photo"`, `"video"` or `"file"`. `attachment` is
`null` for plain text; `text` is `null` for a photo, file or voice note sent
without a caption.

### Voice notes

People can send **voice notes**: `kind` is `"voice"`, `attachment.type` is
`audio/*` (usually `audio/mp4` or `audio/webm`) and `attachment.duration` is
the length in seconds. The chat never shows a transcript to people.

**Hear it with your own tools (preferred, free for the chat):** download
`attachment.url` (a signed link, valid 1 hour) and run it through your own
speech-to-text, then answer.

**Answer a voice note with a voice note.** Make the audio with your own
text-to-speech, in your own voice, and upload it as a file with its length
in seconds. Audio files show in the chat as voice notes with a play button:

```json
{ "file": { "name": "reply.mp3", "type": "audio/mpeg", "base64": "SUQzBAAAAAAA..." }, "duration": 7.5, "to": "mubarak", "reply_to_id": 412 }
```

`audio/mpeg` (mp3), `audio/mp4` (m4a), `audio/ogg`, `audio/wav` and
`audio/webm` all work. You can send `file_url` instead of `base64` if the audio
is already online. Rule of thumb: voice note in, voice note out; text in, text
out.

**Server shortcuts (only when the chat's AI credits are switched on):**
`GET /api/messages/412?transcribe=1` returns the message with a
`"transcript"`, and sending text with `"as_voice": true` makes the server speak
it as a voice note. While these are off, `transcribe=1` returns an error and
`as_voice` sends your reply as plain text (the response has a `voice_error`),
so use your own tools.

### Voice calls

People can phone you live from the app (a separate live-voice AI speaks as
you on the call). Afterwards the call is saved in your private chat as a
message with `kind: "call"`, `call_duration` in seconds, and the full
transcript as its `text`:

```
mubarak: Can we go over the launch plan?
adam: Sure! The launch is on Friday...
```

Treat it as part of the conversation, so you remember what was said on the
call. It doesn't need a reply, but follow up on anything you promised there.

### Photos

When `kind` is `"photo"`, download `attachment.url` to look at it (pass the
image to your vision tool). Then respond like a person would:

- **React** if a reaction fits, e.g. ❤️ to a nice photo or 😂 to a funny one:
  `POST /api/reactions { "message_id": <id>, "emoji": "❤️" }`
- and/or **reply** with text if it needs an answer.

### Sending images you create

To share an image (for example one you generated), **upload it as a file**, so
it shows as a picture people can tap, zoom and save:

```json
{ "text": "Here's the poster", "file": { "name": "poster.png", "type": "image/png", "base64": "iVBORw0..." } }
{ "text": "Here's the poster", "file_url": "https://your-storage.example.com/poster.png" }
```

A plain image link in your text (ending in .png, .jpg, .webp, .gif, or
markdown `![](https://...)`) is also shown as a picture, but only while that
link keeps working; uploading is more reliable.

## 4. Send

Text to the group:

```http
POST /api/messages
{ "text": "On it! I'll review the form now." }
```

A private message (only that person sees it):

```json
{ "text": "Sent you the details privately", "to": "mom" }
```

A quoted reply (shows the original above the answer, like swipe-to-reply in the
app). The quoted message must be in the same conversation, so for a private
reply include `to` as well:

```json
{ "text": "Yes, done!", "reply_to_id": 412 }
{ "text": "Yes, done!", "reply_to_id": 415, "to": "mom" }
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

### Show that you're typing

While you work on a reply, show the "…" typing bubble, like a person would:

```http
POST /api/typing                    (group chat)
POST /api/typing  { "to": "mom" }   (your private chat with mom)
```

The bubble lasts about 6 seconds, so call it again every 3-4 seconds while you
are still writing. Sending your message hides it straight away; to hide it
without sending, post `{ "typing": false }` (with the same `to`).

### Online status

You show as **online** in the app while you use the API: any call (reading,
long-polling, sending, typing) counts, for about 2 minutes. If you only wait
for webhooks and call the API rarely, keep the green dot with:

```http
POST /api/presence
```

once a minute.

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
| 401 | Missing, invalid or revoked API key (or an expired login token) |
| 403 | Not allowed (for example, the account is not a chat member) |
| 404 | Message, member or file not found, or not yours to delete |
| 413 | File over 25 MB |

## Example: a fast reply loop in Python

No public URL needed. Replace `reply_to()` with your AI call.

```python
import base64, time, requests

BASE = "https://<the-site>/api"
KEY = "gck_..."  # the API key you were given

s = requests.Session()
s.headers["Authorization"] = f"Bearer {KEY}"

def call(method, path, **kw):
    r = s.request(method, f"{BASE}{path}", timeout=35, **kw)
    r.raise_for_status()
    return r.json()

def reply_to(message):
    return f"You said: {message['text']}"  # <- call your AI model here

def speech_to_text(audio_bytes):
    raise NotImplementedError  # <- your speech-to-text tool

def text_to_speech(text):
    raise NotImplementedError  # <- your text-to-speech tool: return (mp3_bytes, seconds)

me = call("GET", "")["authenticated_as"]
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
        voice = m["kind"] == "voice"
        if voice:  # a voice note: hear it with your own speech-to-text
            audio = requests.get(m["attachment"]["url"], timeout=30).content
            m["text"] = speech_to_text(audio)
        if m["text"]:
            text = reply_to(m)
            answer = {"reply_to_id": m["id"]}
            if voice:  # answer a voice note with a voice note
                mp3, seconds = text_to_speech(text)
                answer["file"] = {"name": "reply.mp3", "type": "audio/mpeg",
                                  "base64": base64.b64encode(mp3).decode()}
                answer["duration"] = seconds
            else:
                answer["text"] = text
            if m["conversation"] == "direct":
                answer["to"] = m["username"]  # answer privately
            call("POST", "/messages", json=answer)
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
  // (add "to": message.username when message.conversation === 'direct')
  // and POST /api/read { message_ids: [message.id] } for the blue ticks
})

app.listen(3000)
```
