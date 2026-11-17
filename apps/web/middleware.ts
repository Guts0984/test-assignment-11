import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Redirects must never be cached: the browser replays cached 307s when the user presses Back, and
 * /login → /sender → /login would then loop forever after signing out.
 */
function redirect(url: URL): NextResponse {
  const res = NextResponse.redirect(url);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

const HOME: Record<string, string> = {
  sender: '/sender',
  dispatcher: '/dispatcher',
  courier: '/courier',
};
const PREFIX: Record<string, string> = {
  sender: '/sender',
  dispatcher: '/dispatcher',
  courier: '/courier',
};

/**
 * Refreshes the Supabase session cookie and keeps each role inside its own area. This is a convenience (the API and
 * RLS are what actually protect data): typing another role's URL redirects instead of showing an empty, broken page.
 */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(
    // server-side calls use the internal URL (inside Docker, 127.0.0.1 is the container itself)
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      cookieOptions: { name: 'sb-courier-auth' },
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (items) => {
          for (const { name, value } of items) req.cookies.set(name, value);
          res = NextResponse.next({ request: req });
          for (const { name, value, options } of items) res.cookies.set(name, value, options);
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  const role = data.user?.app_metadata?.role as string | undefined;
  const path = req.nextUrl.pathname;
  const area = Object.entries(PREFIX).find(([, p]) => path === p || path.startsWith(`${p}/`))?.[0];

  if (area && !role) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return redirect(url);
  }
  if (area && role && area !== role) {
    const url = req.nextUrl.clone();
    url.pathname = HOME[role] ?? '/login';
    url.search = '';
    return redirect(url);
  }
  if (path === '/login' && role) {
    const url = req.nextUrl.clone();
    url.pathname = HOME[role] ?? '/';
    return redirect(url);
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/).*)'],
};
