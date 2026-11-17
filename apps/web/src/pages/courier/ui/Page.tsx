'use client';
import { useEffect } from 'react';
import { CourierApp } from '@/widgets/courier-app';

export function CourierPage() {
  useEffect(() => {
    // the service worker makes the app open and work without a connection
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return (
    <main>
      <CourierApp />
    </main>
  );
}
