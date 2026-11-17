/** Public, browser-safe settings only (URLs and the anon key). The service-role key never reaches this app. */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  defaultLocale: (process.env.NEXT_PUBLIC_DEFAULT_LOCALE ?? 'en') as 'en' | 'uk',
} as const;

/** Cookie name shared by browser, server and middleware (the default depends on the URL's hostname, which differs inside Docker). */
export const AUTH_COOKIE = 'sb-courier-auth';
