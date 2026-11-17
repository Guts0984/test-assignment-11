import { Suspense } from 'react';
import { DispatchBoardPage } from '@/pages/dispatch-board';

export default function Route() {
  return (
    <Suspense>
      <DispatchBoardPage />
    </Suspense>
  );
}
