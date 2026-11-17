import { testEnv } from '../src/testing/env';

/** Fail fast, with a useful message, when the local Supabase stack is not running. */
export default async function setup(): Promise<void> {
  const env = testEnv();
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/health`, {
      headers: { apikey: env.anonKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`auth health returned ${res.status}`);
  } catch (e) {
    throw new Error(
      `Local Supabase is not reachable at ${env.supabaseUrl}. Run "pnpm supabase start" first. (${String(e)})`,
    );
  }
}
