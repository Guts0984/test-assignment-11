'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/features/switch-locale';
import { SignOutButton } from '@/features/sign-in';
import { useSession } from '@/entities/session';

const LINKS = {
  sender: [
    ['/sender', 'deliveries'],
    ['/sender/new', 'create'],
    ['/sender/notifications', 'notifications'],
    ['/sender/settings', 'settings'],
  ],
  dispatcher: [
    ['/dispatcher', 'board'],
    ['/dispatcher/deliveries', 'allDeliveries'],
    ['/dispatcher/report', 'report'],
  ],
  courier: [['/courier', 'courier']],
} as const;

export function AppHeader() {
  const t = useTranslations('nav');
  const path = usePathname() ?? '';
  const s = useSession();
  const links = s.role ? LINKS[s.role] : [];
  const bare = path.startsWith('/track') || path.startsWith('/login');
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
        <Link href="/" prefetch={false} className="text-base font-semibold">
          {t('brand')}
        </Link>
        {!bare && (
          <nav aria-label={t('main')} className="flex flex-wrap gap-1">
            {links.map(([href, key]) => {
              const active =
                path === href ||
                (href !== '/sender' && href !== '/dispatcher' && path.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded px-2 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                >
                  {t(key)}
                </Link>
              );
            })}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitcher />
          {!bare && s.role && (
            <>
              <span className="hidden text-xs text-slate-600 sm:inline">{s.email}</span>
              <SignOutButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
