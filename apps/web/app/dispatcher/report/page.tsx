import { Suspense } from 'react';
import { ReportPage } from '@/pages/report';

export default function Route() {
  return (
    <Suspense>
      <ReportPage />
    </Suspense>
  );
}
