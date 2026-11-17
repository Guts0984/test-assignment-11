import { useState, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { jsonResponse, messages, renderApp } from './helpers';

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, replace: h.replace, refresh: vi.fn() }),
  usePathname: () => '/dispatcher/report',
  useSearchParams: () => h.params,
}));
vi.mock('@/shared/api/supabase', () => {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return {
    getSupabase: () => ({
      realtime: { setAuth: async () => undefined },
      channel: () => channel,
      removeChannel: async () => undefined,
    }),
    getAccessToken: async () => 'token',
  };
});

import { AssignDialog } from '@/features/assign-delivery';
import { FiltersBar } from '@/features/delivery-filters';
import { CreateDeliveryForm } from '@/features/create-delivery';
import { DeliverDialog, FailDialog } from '@/features/courier-actions';
import { ReportView } from '@/widgets/report-view';
import { DispatchBoard } from '@/widgets/dispatch-board';
import { EMPTY_FILTERS } from '@/shared/lib';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  h.push.mockReset();
  h.replace.mockReset();
  h.params = new URLSearchParams();
});

/** Like renderApp, but `rerender` keeps the providers (and the query client). */
function renderKeep(ui: ReactElement) {
  function Providers({ children }: { children: ReactNode }) {
    const [client] = useState(
      () =>
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
        }),
    );
    return (
      <NextIntlClientProvider locale="en" messages={messages.en} timeZone="Europe/Kyiv">
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    );
  }
  const r = render(<Providers>{ui}</Providers>);
  return { ...r, rerender: (next: ReactElement) => r.rerender(<Providers>{next}</Providers>) };
}

const axeViolations = async (el: HTMLElement) =>
  (await axe.run(el, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
    (v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`,
  );

const couriers = [
  { id: 'c1', name: 'Taras', onShift: true, shiftId: 's', openedAt: null, active: 0, limit: 5 },
];

describe('AssignDialog', () => {
  it('a live status change to "assigned" while open does not turn the click into a reassign', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'ALREADY_ASSIGNED', message: 'x' } }, 409),
    );
    const target = { id: 'd1', number: 'DLV-000001', status: 'created' };
    const { rerender } = renderKeep(
      <AssignDialog delivery={target} couriers={couriers} onClose={vi.fn()} />,
    );
    rerender(
      <AssignDialog
        delivery={{ ...target, status: 'assigned' }}
        couriers={couriers}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/already assigned. Choosing/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Taras/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This delivery is already assigned.',
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      reassign: boolean;
    };
    expect(body.reassign).toBe(false);
  });

  it('a delivery opened as "assigned" is a deliberate reassign', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    renderApp(
      <AssignDialog
        delivery={{ id: 'd1', number: 'DLV-000001', status: 'assigned' }}
        couriers={couriers}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /Taras/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      reassign: boolean;
    };
    expect(body.reassign).toBe(true);
  });
});

describe('FiltersBar date inputs', () => {
  it('keeps half-typed dates in the input and applies only complete valid ones, never dropping the other date', () => {
    const onApply = vi.fn();
    renderApp(<FiltersBar value={EMPTY_FILTERS} onApply={onApply} />);
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    fireEvent.change(from, { target: { value: '0002-10-01' } });
    expect(from).toHaveValue('0002-10-01');
    fireEvent.change(from, { target: { value: '2026-02-30' } });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(from, { target: { value: '2026-01-10' } });
    fireEvent.change(to, { target: { value: '2026-02-01' } });
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-01-10', to: '2026-02-01', page: 1 }),
    );
    expect(from).toHaveValue('2026-01-10');
    fireEvent.change(to, { target: { value: '' } });
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-01-10', to: '' }),
    );
  });
});

const report = (items: unknown[]) => ({
  period: { from: '2026-01-01', to: '2026-02-01' },
  delivered: { count: 3, avgAssignToDeliverSeconds: 600 },
  failedAttempts: { total: 1, byReason: [{ reason: 'recipient_absent', count: 1 }] },
  cashDiscrepancies: { shifts: items.length, totalKop: -500, absoluteTotalKop: 500, items },
});

describe('ReportView', () => {
  beforeEach(() => {
    h.params = new URLSearchParams('from=2026-01-01&to=2026-02-01');
  });

  it('shows a field error and sends nothing for from > to, > 366 days or an invalid date', async () => {
    fetchMock.mockResolvedValue(jsonResponse(report([])));
    renderApp(<ReportView />);
    await screen.findByTestId('report');
    fetchMock.mockClear();
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    const show = () => userEvent.click(screen.getByRole('button', { name: 'Show' }));

    fireEvent.change(from, { target: { value: '2026-03-01' } });
    await show();
    expect(from).toHaveAccessibleDescription('The start date must not be after the end date');
    expect(from).toHaveFocus();

    fireEvent.change(from, { target: { value: '2024-01-01' } });
    await show();
    expect(to).toHaveAccessibleDescription('The period must not be longer than 366 days');

    fireEvent.change(from, { target: { value: '2025-02-01' } }); // exactly 366 days to 2026-02-01 inclusive
    await show();
    expect(h.push).toHaveBeenCalledWith('/dispatcher/report?from=2025-02-01&to=2026-02-01');

    h.push.mockClear();
    fireEvent.change(from, { target: { value: '' } });
    await show();
    expect(from).toHaveAccessibleDescription('Enter a valid date');
    expect(h.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-syncs the inputs when the URL changes (browser Back)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(report([])));
    const { rerender } = renderKeep(<ReportView />);
    expect(await screen.findByLabelText('From')).toHaveValue('2026-01-01');
    h.params = new URLSearchParams('from=2025-06-01&to=2025-07-01');
    rerender(<ReportView />);
    await waitFor(() => expect(screen.getByLabelText('From')).toHaveValue('2025-06-01'));
    expect(screen.getByLabelText('To')).toHaveValue('2025-07-01');
  });

  it('the discrepancy table is a focusable labelled region and the page has no axe violations', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        report([
          {
            shiftId: 's1',
            courierId: 'c1',
            courierName: 'Taras',
            closedAt: '2026-01-05T10:00:00Z',
            expectedKop: 10_000,
            handedKop: 9_500,
            discrepancyKop: -500,
          },
        ]),
      ),
    );
    const { container } = renderApp(<ReportView />);
    const region = await screen.findByRole('region', {
      name: 'Cash discrepancies table, scrollable',
    });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('CreateDeliveryForm network failures', () => {
  const fill = async () => {
    const u = userEvent.setup();
    for (const [label, value] of [
      ['Full name', 'Olena Kovalenko'],
      ['Phone', '0671234567'],
      ['City', 'Kyiv'],
      ['Street', 'Khreshchatyk'],
      ['House', '22'],
      ['Weight, kg', '1,5'],
    ] as const)
      await u.type(screen.getByLabelText(label), value);
    return u;
  };
  const posts = () =>
    fetchMock.mock.calls.filter(
      (c) => String(c[0]).endsWith('/deliveries') && (c[1] as RequestInit).method === 'POST',
    );
  const respond = (create: () => Response) =>
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/quote')
        ? jsonResponse({ feeKop: 1, codCommissionKop: 0, totalKop: 1 })
        : create(),
    );

  it('offline: sends nothing, shows the connection message and keeps the input', async () => {
    respond(() => jsonResponse({ id: 'x' }, 201));
    renderApp(<CreateDeliveryForm />);
    const u = await fill();
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No connection to the server.');
    expect(posts()).toHaveLength(0);
    expect(screen.getByLabelText('City')).toHaveValue('Kyiv');
    expect(screen.getByRole('button', { name: 'Create delivery' })).toBeEnabled();
    online.mockRestore();
  });

  it('the request carries an abort signal (15 s timeout) and an abort shows the connection message', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/quote'))
        return jsonResponse({ feeKop: 1, codCommissionKop: 0, totalKop: 1 });
      throw new DOMException('timed out', 'TimeoutError');
    });
    renderApp(<CreateDeliveryForm />);
    const u = await fill();
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No connection to the server.');
    expect((posts()[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('IDEMPOTENCY_KEY_REUSED with a deliveryId links to the already created delivery', async () => {
    respond(() =>
      jsonResponse(
        {
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'x',
            details: { deliveryId: 'abc-123' },
          },
        },
        422,
      ),
    );
    renderApp(<CreateDeliveryForm />);
    const u = await fill();
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    const link = await screen.findByRole('link', { name: 'Open the created delivery' });
    expect(link).toHaveAttribute('href', '/sender/abc-123');
    expect(screen.getByRole('status')).toHaveTextContent('actually created this delivery');
  });

  it('IDEMPOTENCY_KEY_REUSED without a deliveryId falls back to the normal text', async () => {
    respond(() => jsonResponse({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'x' } }, 422));
    renderApp(<CreateDeliveryForm />);
    const u = await fill();
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This request was already sent with different data.',
    );
    expect(screen.queryByRole('link', { name: 'Open the created delivery' })).toBeNull();
  });
});

describe('DispatchBoard order', () => {
  const board = {
    generatedAt: '2026-01-01T00:00:00Z',
    zones: [{ zone: 'A', waiting: 0, items: [] }],
    couriers: [],
    blocked: [],
  };

  it('requests oldest by default and newest when the URL says so; the selector updates the URL', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(board));
    const first = renderApp(<DispatchBoard />);
    const select = await screen.findByLabelText('Queue order');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/dispatch/board?order=oldest');
    fireEvent.change(select, { target: { value: 'newest' } });
    expect(h.replace).toHaveBeenCalledWith('/dispatcher/report?order=newest');
    first.unmount();

    h.params = new URLSearchParams('order=newest');
    fetchMock.mockClear();
    renderApp(<DispatchBoard />);
    expect(await screen.findByLabelText('Queue order')).toHaveValue('newest');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/dispatch/board?order=newest');
    fireEvent.change(screen.getByLabelText('Queue order'), { target: { value: 'oldest' } });
    expect(h.replace).toHaveBeenLastCalledWith('/dispatcher/report');
  });
});

describe('courier dialogs move focus to the first invalid field', () => {
  const target = { id: 'd1', number: 'DLV-000001', amountDueKop: 10_000 };

  it('deliver: code, then the photo once the code is right', async () => {
    renderApp(<DeliverDialog target={target} onClose={vi.fn()} onSubmit={vi.fn()} />);
    const submit = screen.getByRole('button', { name: 'Confirm handover' });
    await userEvent.click(submit);
    expect(screen.getByLabelText("Recipient's code")).toHaveFocus();
    await userEvent.type(screen.getByLabelText("Recipient's code"), '123456');
    await userEvent.click(submit);
    expect(screen.getByLabelText('Photo of the handover')).toHaveFocus();
  });

  it('deliver: an invalid amount is focused before the photo', async () => {
    renderApp(<DeliverDialog target={target} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Recipient's code"), '123456');
    await userEvent.type(screen.getByLabelText('Amount received, ₴'), 'lots');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm handover' }));
    expect(screen.getByLabelText('Amount received, ₴')).toHaveFocus();
  });

  it('fail: note when reason is "other" and empty, otherwise the photo', async () => {
    renderApp(<FailDialog target={target} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByLabelText('Photo of the door or entrance')).toHaveFocus();
    await userEvent.selectOptions(screen.getByLabelText('Reason'), 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByLabelText('Note')).toHaveFocus();
  });
});
