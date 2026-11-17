import { Suspense } from 'react';
import { LoginPage } from '@/pages/login';

export default function Route() {
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
