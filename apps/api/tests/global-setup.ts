import { testEnv } from '@courier/db/testing';

export default async function setup(): Promise<void> {
  const env = testEnv();
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/health`, {
      headers: { apikey: env.anonKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`auth health ${res.status}`);
  } catch (e) {
    throw new Error(
      `Local Supabase is not reachable. Run "pnpm supabase start" first. (${String(e)})`,
    );
  }
}
