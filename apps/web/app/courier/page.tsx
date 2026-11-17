import { Suspense } from 'react';
import { CourierPage } from '@/pages/courier';

export default function Route() {
  return (
    <Suspense>
      <CourierPage />
    </Suspense>
  );
}
