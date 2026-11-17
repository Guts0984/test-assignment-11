import { api } from '@/shared/api';
import type { Today } from '../model/model';

export const fetchToday = () => api<Today>('/courier/today');
export const openShift = () =>
  api<{ shiftId: string; openedAt: string }>('/courier/shift/open', { method: 'POST' });
