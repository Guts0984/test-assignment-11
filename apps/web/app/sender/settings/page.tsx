import { Suspense } from 'react';
import { SenderSettingsPage } from '@/pages/sender-settings';

export default function Route() {
  return (
    <Suspense>
      <SenderSettingsPage />
    </Suspense>
  );
}
