import { Suspense } from 'react';
import { DeliveryDetailPage } from '@/pages/delivery-detail';

export default async function Route({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <DeliveryDetailPage id={id} viewer="sender" />
    </Suspense>
  );
}
