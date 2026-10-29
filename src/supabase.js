import { createClient } from '@supabase/supabase-js'

const env = import.meta.env
const url = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
const key =
  env.VITE_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!url || !key) {
  throw new Error('Missing Supabase settings: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or connect the Vercel Supabase integration)')
}

export const supabase = createClient(url, key)

// For direct uploads with progress (src/media.js).
export const SUPABASE_URL = url
export const SUPABASE_KEY = key

export const BUCKET = 'chat-files'

// Supabase Auth signs in with an email, so each username maps to an internal
// address. Keep in sync with public.create_chat_user() in the migration.
export const usernameToEmail = (username) => `${username.trim().toLowerCase()}@chat.local`

export const AVATAR_BUCKET = 'avatars'

export const avatarUrl = (path) =>
  path ? supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl : null
