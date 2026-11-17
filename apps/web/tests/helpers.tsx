import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/shared/i18n/messages/en.json';
import uk from '@/shared/i18n/messages/uk.json';

export const messages = { en, uk };

export function renderApp(ui: ReactElement, locale: 'en' | 'uk' = 'en'): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="Europe/Kyiv">
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
