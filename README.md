# Group Chat

One shared group chat for a closed set of people. Built with React (Vite), Supabase
(auth, Postgres, realtime, storage) and deployed on Vercel.

- Log in with a username and password given to you by the admin (no public sign-up)
- Send messages, photos/videos and any file (up to 25 MB), with paste and drag-and-drop
- React to messages with emoji; delete your own messages
- Set a profile photo (tap **N People** at the top → Add Photo)
- Live updates and an online count

## Adam, the AI member (runs on Vercel)

`api/bot.js` makes the chat user **adam** reply on his own within a few seconds, with no
computer or browser left running: Supabase sends each new message to the function, which
asks Claude for Adam's reply and posts it as adam. In the group he answers when he is
mentioned, asked something or replied to, and stays quiet otherwise; private messages to
him always get an answer. His personality is in `api/_adam.js`.

Setup:

1. In Vercel → Settings → Environment Variables (Production), add:
   - `ANTHROPIC_API_KEY`: a Claude API key from console.anthropic.com
   - `BOT_USERNAME`: `adam`
   - `BOT_PASSWORD`: adam's chat password
   - optional `BOT_MODEL` (default `claude-opus-5-5`) and `BOT_EFFORT` (`low` default, fastest; `medium`/`high` for more careful answers)
2. Redeploy, then open `https://<your-app>/api/bot` once. It registers the webhook and
   should show `"ready": true`.
3. Turn off any other agent or browser automation that posts as adam, or he will answer twice.

## Bots and AI agents

An agent can log in with its own username and password and chat through a small HTTP API,
with instant delivery of new messages by webhook or long-polling. See [AGENT_API.md](AGENT_API.md).

## Managing users (admin)

Open the Supabase dashboard → **SQL Editor** and run:

```sql
-- add a user
select public.create_chat_user('alice', 'a-strong-password');

-- change a password
select public.set_chat_user_password('alice', 'new-password');

-- remove a user (also deletes their messages and reactions)
select public.delete_chat_user('alice');

-- list users
select username, created_at from public.profiles order by username;
```

Usernames are lowercase letters, digits, `_`, `.` or `-` (2–32 chars). Passwords need at least 6 characters.
These functions can only be run from the SQL editor, not from the app.

Recommended: in **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**.
Even with sign-up left on, accounts not created by `create_chat_user` can't read or post anything.

## Setup from scratch

1. Run the files in `supabase/migrations/` in order in your Supabase project's SQL editor.
2. Copy `.env.example` to `.env.local` and fill in the project URL and publishable (anon) key.
3. `npm install && npm run dev`
4. On Vercel, import the repo and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
