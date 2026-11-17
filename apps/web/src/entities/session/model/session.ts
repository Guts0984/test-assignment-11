'use client';
import { useEffect, useState } from 'react';
import type { Role } from '@courier/shared';
import { getSupabase } from '@/shared/api';

export type SessionInfo = { loading: boolean; role: Role | null; email: string | null };

export const roleHome = (role: Role | null): string =>
  role === 'sender'
    ? '/sender'
    : role === 'dispatcher'
      ? '/dispatcher'
      : role === 'courier'
        ? '/courier'
        : '/login';

/** The role is read from app_metadata, which only the service role can write. */
export function useSession(): SessionInfo {
  const [s, setS] = useState<SessionInfo>({ loading: true, role: null, email: null });
  useEffect(() => {
    const supabase = getSupabase();
    const apply = (
      user: { email?: string | null; app_metadata?: Record<string, unknown> } | null,
    ) =>
      setS({
        loading: false,
        role: (user?.app_metadata?.role as Role | undefined) ?? null,
        email: user?.email ?? null,
      });
    void supabase.auth.getUser().then(({ data }) => apply(data.user));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => apply(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  return s;
}
