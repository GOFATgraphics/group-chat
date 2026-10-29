import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
}

export const supabase = createClient(url, key)

export const BUCKET = 'chat-files'

// Supabase Auth signs in with an email, so each username maps to an internal
// address. Keep in sync with public.create_chat_user() in the migration.
export const usernameToEmail = (username) => `${username.trim().toLowerCase()}@chat.local`

export const AVATAR_BUCKET = 'avatars'

export const avatarUrl = (path) =>
  path ? supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl : null
