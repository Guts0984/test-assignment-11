import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
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
    return NextResponse.redirect(url);
  }
  if (area && role && area !== role) {
    const url = req.nextUrl.clone();
    url.pathname = HOME[role] ?? '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  if (path === '/login' && role) {
    const url = req.nextUrl.clone();
    url.pathname = HOME[role] ?? '/';
    return NextResponse.redirect(url);
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/).*)'],
};
