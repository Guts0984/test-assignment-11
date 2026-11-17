'use client';
import { TrackingCard } from '@/widgets/tracking-card';

export function TrackPage({ token }: { token: string }) {
  return (
    <main className="px-4 py-8">
      <TrackingCard token={token} />
    </main>
  );
}
