import { Suspense } from 'react';
import { SenderNewPage } from '@/pages/sender-new';

export default function Route() {
  return (
    <Suspense>
      <SenderNewPage />
    </Suspense>
  );
}
