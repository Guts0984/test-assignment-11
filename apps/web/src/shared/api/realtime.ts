'use client';
import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { getAccessToken, getSupabase } from './supabase';

/**
 * Re-fetches the given queries whenever one of the tables changes (Supabase Realtime, filtered by RLS for this user).
 * One channel per hook: supabase-js joins a client's second and later channels with the anon key, so channels are
 * created only after the user's token is set, and each page uses a single hook.
 */
export function useRealtimeInvalidate(tables: string[], keys: QueryKey[], enabled = true) {
  const qc = useQueryClient();
  const tableKey = tables.join(',');
  const keyJson = JSON.stringify(keys);
  useEffect(() => {
    if (!enabled) return;
    const supabase = getSupabase();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const k of JSON.parse(keyJson) as QueryKey[])
          void qc.invalidateQueries({ queryKey: k });
      }, 150);
    };
    void (async () => {
      const token = await getAccessToken();
      if (cancelled) return;
      if (token) await supabase.realtime.setAuth(token);
      let ch = supabase.channel(`live-${tableKey}-${Math.random().toString(36).slice(2)}`);
      for (const table of tableKey.split(','))
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
      channel = ch.subscribe();
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (channel) void getSupabase().removeChannel(channel);
    };
  }, [tableKey, keyJson, enabled, qc]);
}

export type TrackingMessage = {
  number: string;
  status: string;
  attemptNo: number;
  courierName: string | null;
  amountDueKop: number;
  updatedAt: string;
};

/** Anonymous Broadcast subscription for the tracking page. The payload is the safe projection built by a DB trigger. */
export function useTrackingBroadcast(
  channelName: string | undefined,
  onMessage: (m: TrackingMessage) => void,
) {
  useEffect(() => {
    if (!channelName) return;
    const supabase = getSupabase();
    const ch = supabase
      .channel(`tracking:${channelName}`)
      .on('broadcast', { event: 'tracking' }, (m) => onMessage(m.payload as TrackingMessage))
      .subscribe();
    return () => void supabase.removeChannel(ch);
    // the callback is intentionally read from the first render only
  }, [channelName]);
}
