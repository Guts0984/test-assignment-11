'use client';
import { useTranslations } from 'next-intl';
import type { DeliveryStatus } from '@courier/shared';
import { Badge } from '@/shared/ui';

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  const t = useTranslations('status');
  return <Badge status={status}>{t(status)}</Badge>;
}
