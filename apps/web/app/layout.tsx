import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Providers } from '@/app/providers';
import { AppHeader } from '@/widgets/app-header';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'Courier delivery',
  description: 'City courier delivery',
};

export const viewport: Viewport = { themeColor: '#0f172a', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-white focus:p-2"
            >
              Skip to content
            </a>
            <AppHeader />
            <div id="main">{children}</div>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
