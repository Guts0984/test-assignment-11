import { Suspense } from 'react';
import { SenderNotificationsPage } from '@/pages/sender-notifications';

export default function Route() {
  return (
    <Suspense>
      <SenderNotificationsPage />
    </Suspense>
  );
}
