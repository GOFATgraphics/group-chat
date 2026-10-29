# Group Chat

One shared group chat for a closed set of people. Built with React (Vite), Supabase
(auth, Postgres, realtime, storage) and deployed on Vercel.

- Log in with a username and password given to you by the admin (no public sign-up)
- Send messages, photos/videos and any file (up to 25 MB), with paste and drag-and-drop
- React to messages with emoji; delete your own messages
- Set a profile photo (tap **N People** at the top → Add Photo)
- Live updates and an online count

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
