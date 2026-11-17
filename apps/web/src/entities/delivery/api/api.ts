import { api, type ListPage } from '@/shared/api';
import type { CardDto, DeliveryDto, PhotoUrl, Quote } from '../model/model';
import { PAGE_SIZE } from '../model/model';

export const fetchList = (scope: 'sender' | 'dispatcher', query: string) => {
  const sp = new URLSearchParams(query);
  sp.set('pageSize', String(PAGE_SIZE));
  return api<ListPage<DeliveryDto>>(
    `${scope === 'sender' ? '/deliveries' : '/dispatch/deliveries'}?${sp.toString()}`,
  );
};
export const fetchCard = (id: string) => api<CardDto>(`/deliveries/${id}`);
export const fetchPhotos = (id: string) => api<{ items: PhotoUrl[] }>(`/deliveries/${id}/photos`);
export const fetchQuote = (b: { zone: string; weightG: number; codKop: number }) =>
  api<Quote>('/deliveries/quote', { method: 'POST', body: b });
export const cancelDelivery = (id: string) =>
  api<{ delivery: DeliveryDto; changed: boolean }>(`/deliveries/${id}/cancel`, { method: 'POST' });
