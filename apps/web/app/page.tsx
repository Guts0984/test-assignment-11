import { redirect } from 'next/navigation';
import { getServerSupabase } from '@/shared/server';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const supabase = await getServerSupabase();
  const { data } = await supabase.auth.getUser();
  const role = data.user?.app_metadata?.role as string | undefined;
  redirect(
    role === 'sender'
      ? '/sender'
      : role === 'dispatcher'
        ? '/dispatcher'
        : role === 'courier'
          ? '/courier'
          : '/login',
  );
}
