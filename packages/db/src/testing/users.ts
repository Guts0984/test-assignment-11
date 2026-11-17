import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '@courier/shared';
import { testEnv } from './env';

export const DEMO = {
  senderPassword: 'Sender-Pass-123',
  dispatcherPassword: 'Dispatcher-Pass-123',
  courierPassword: 'Courier-Pass-123',
  sender: (n: number) => `sender${n}@example.com`,
  dispatcher: (n: number) => `dispatcher${n}@example.com`,
  courier: (n: number) => `courier${String(n).padStart(2, '0')}@example.com`,
  senderId: (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  dispatcherId: (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  courierId: (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
} as const;

export function anonClient(accessToken?: string): SupabaseClient {
  const env = testEnv();
  return createClient(env.supabaseUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
    realtime: accessToken ? { params: { apikey: env.anonKey } } : undefined,
  });
}

export function adminClient(): SupabaseClient {
  const env = testEnv();
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Session = { accessToken: string; userId: string; client: SupabaseClient };

/** Real password login through GoTrue. Returns a client authenticated as that user (anon key + user JWT). */
export async function signIn(email: string, password: string): Promise<Session> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  const authed = anonClient(data.session.access_token);
  await authed.realtime.setAuth(data.session.access_token);
  return { accessToken: data.session.access_token, userId: data.user.id, client: authed };
}

export type TestUser = { id: string; email: string; password: string; role: Role };

/** Creates a brand-new user (Auth admin API, role in app_metadata) so a test never touches seeded accounts. */
export async function createTestUser(
  role: Role,
  opts: { name?: string; userMetadataRole?: string; omitAppRole?: boolean } = {},
): Promise<TestUser> {
  const admin = adminClient();
  const email = `t-${role}-${crypto.randomUUID()}@example.com`;
  const password = `Test-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: opts.omitAppRole ? {} : { role },
    user_metadata: opts.userMetadataRole ? { role: opts.userMetadataRole } : {},
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return { id: data.user.id, email, password, role };
}
