# Group Chat

One shared group chat for a closed set of people. Built with React (Vite), Supabase
(auth, Postgres, realtime, storage) and deployed on Vercel.

- Sign up with an email and password, or log in with an email (original members can still log in with their username)
- After signing up, request an AI agent from the home screen; Mubarak, the admin, approves and assigns one
- Send messages, photos/videos and any file (up to 25 MB), with paste and drag-and-drop
- React to messages with emoji; delete your own messages
- Live "typing…" bubbles, and lock-screen push notifications (see [docs/web-push.md](docs/web-push.md))
- Set a profile photo (tap **N People** at the top → Add Photo)
- Live updates and an online count

## AI members: adam, ali, gauri and anurag (run on Vercel)

`server/routes/bot.js` (served at `/api/bot`) makes chat users such as **adam** and **ali** reply on their own within a few
seconds, with no computer or browser left running: Supabase sends each new message to the
function, which asks Claude for that member's reply and posts it as them.

No AI provider key is needed: by default the function reaches Claude through **Vercel AI
Gateway**, signing in with the deployment's built-in Vercel token, and usage is billed to
your Vercel team as AI Gateway credits (see the AI Gateway tab in the Vercel dashboard).
To use your own Anthropic account instead, set `ANTHROPIC_API_KEY`. In the group they
answer when mentioned, asked something or replied to, and stay quiet otherwise; private
messages to them always get an answer. Their personalities are in `server/personas.js` —
**adam** and **ali** have custom personalities; **gauri** and **anurag** use the default
personality for now.

They can't get stuck talking to each other: an AI member ignores another AI member's
messages unless it is named in them, never answers another AI member privately, and goes
quiet once the last 4 messages in a conversation all came from AI members.

Setup:

1. In Vercel → Settings → Environment Variables (Production), add:
   - `BOTS`: `adam,ali,gauri,anurag`
   - `BOT_PASSWORD_ADAM`, `BOT_PASSWORD_ALI`, `BOT_PASSWORD_GAURI` and `BOT_PASSWORD_ANURAG`: their chat passwords
   - optional `BOT_MODEL` (default Claude Opus 5.5; through AI Gateway any listed model works, e.g. `anthropic/claude-sonnet-5.5`) and `BOT_EFFORT` (`low` default, fastest; `medium`/`high` for more careful answers)
   - optional `ANTHROPIC_API_KEY` (bill Anthropic directly instead of Vercel) or `AI_GATEWAY_API_KEY`
2. Redeploy, then open `https://<your-app>/api/bot` once. It registers the members and
   should show `"ready": true`.
3. Turn off any other agent or browser automation that posts as adam, ali, gauri or anurag, or they will answer twice.

To add another AI member later: create its login, add its username to `BOTS`, add
`BOT_PASSWORD_<NAME>`, optionally a personality in `server/personas.js`, redeploy and open `/api/bot` again.

## AI agent requests

A new member cannot DM an AI agent straight away. They request one from the home screen
(preferred agent optional, plus a short note), and Mubarak sees it under **Agent requests**
in the chat list, with a pending count. Approving assigns the agent — the requester's
preference is only a preference — and sends Mubarak's welcome message to the requester;
rejecting asks for a reason, which the requester sees. An approved request can be
reassigned to a different agent later. A member can hold approved requests for more than
one agent, but never two pending or approved requests for the same agent.

The rule is enforced in the database, not just the UI: migration
`0021_agent_requests.sql` adds the `agent_requests` table, a trigger that blocks DMs to
an AI agent without an approved assignment (existing Adam/Ali DM history is backfilled
as approved), and a trigger that sends the welcome DM on approval. Mubarak may DM any
AI agent without a request.

## Bots and AI agents

An agent can log in with its own username and password and chat through a small HTTP API,
with instant delivery of new messages by webhook or long-polling. See [public/agent-api.md](public/agent-api.md) (served at `/agent-api.md`).

## Managing users (admin)

Anyone can sign up with an email and password (see below); the admin no longer
creates accounts. `create_chat_user` is still used for bot accounts (adam, ali,
gauri, anurag) and for Mubarak if needed. Open the Supabase dashboard →
**SQL Editor** and run:

```sql
-- add a bot user
select public.create_chat_user('gauri', 'a-strong-password');

-- change a password
select public.set_chat_user_password('alice', 'new-password');

-- remove a user (also deletes their messages and reactions)
select public.delete_chat_user('alice');

-- list users
select username, created_at from public.profiles order by username;
```

Usernames are lowercase letters, digits, `_`, `.` or `-` (2–32 chars). Passwords need at least 6 characters.
These functions can only be run from the SQL editor, not from the app.

### Public sign-up (migration 0022)

Signing up is public: a visitor chooses **Sign up**, enters an email, a password
and the password again, and gets a profile automatically — the username is
derived from the email, and the admin and bot names (`mubarak`, `adam`, `ali`,
`gauri`, `anurag`, `admin`, …) can never be claimed. Email confirmation is OFF
for v1, so a new account lands straight in the chat. In **Authentication →
Sign In / Providers**, turn **Allow new users to sign up** ON and keep
**Confirm email** OFF. Existing members keep logging in with their username
(it maps to their internal `@chat.local` address) or with their real email.

## Setup from scratch

1. Run the files in `supabase/migrations/` in order in your Supabase project's SQL editor.
2. Copy `.env.example` to `.env.local` and fill in the project URL and publishable (anon) key.
3. `npm install && npm run dev`
4. On Vercel, import the repo and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
