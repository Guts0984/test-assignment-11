import { Suspense } from 'react';
import { DispatcherListPage } from '@/pages/dispatcher-list';

export default function Route() {
  return (
    <Suspense>
      <DispatcherListPage />
    </Suspense>
  );
}
