import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '../config/env';

/** Server-side client bound to the request cookies. Uses the anon key only. */
export async function getServerSupabase() {
  const jar = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
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
  });
}
