import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { AUTH_COOKIE, publicEnv } from '../config/env';

/** Server-side client bound to the request cookies. Uses the anon key only. */
export async function getServerSupabase() {
  const jar = await cookies();
  return createServerClient(
    process.env.SUPABASE_INTERNAL_URL || publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookieOptions: { name: AUTH_COOKIE },
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (items) => {
          try {
            for (const { name, value, options } of items) jar.set(name, value, options);
          } catch {
            /* called from a Server Component: the middleware refreshes the session instead */
          }
        },
      },
    },
  );
}
