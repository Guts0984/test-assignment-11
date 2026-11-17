import { Suspense } from 'react';
import { SenderListPage } from '@/pages/sender-list';

export default function Route() {
  return (
    <Suspense>
      <SenderListPage />
    </Suspense>
  );
}
