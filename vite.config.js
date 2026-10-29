import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Also expose the public Supabase values that Vercel's Supabase integration
  // adds (NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY / _ANON_KEY), so the app
  // works without copying them into VITE_ variables. Only these public names
  // reach the browser; server secrets never do.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_SUPABASE_'],
})
