'use client';
import { useEffect } from 'react';
import { CourierApp } from '@/widgets/courier-app';

/** Registers the service worker and hands it everything this page already loaded, so the app opens offline right away. */
async function enableOffline(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const urls = performance
    .getEntriesByType('resource')
    .map((r) => r.name)
    .filter((n) => n.includes('/_next/static/'));
  (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'precache', urls });
}

export function CourierPage() {
  useEffect(() => {
    void enableOffline().catch(() => undefined);
  }, []);
  return (
    <main>
      <CourierApp />
    </main>
  );
}
