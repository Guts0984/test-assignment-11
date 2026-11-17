import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { jsonResponse, renderApp } from './helpers';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
  usePathname: () => '/sender/new',
  useSearchParams: () => new URLSearchParams(),
}));
const signIn = vi.fn();
vi.mock('@/shared/api/supabase', () => ({
  getSupabase: () => ({
    auth: {
      signInWithPassword: signIn,
      getSession: async () => ({ data: { session: { access_token: 't' } } }),
    },
  }),
  getAccessToken: async () => 'token',
}));

import { LoginForm } from '@/features/sign-in';
import { CreateDeliveryForm } from '@/features/create-delivery';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  push.mockReset();
  replace.mockReset();
  signIn.mockReset();
});

const axeViolations = async (el: HTMLElement) =>
  (await axe.run(el, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
    (v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`,
  );

describe('login form', () => {
  it('shows a message next to each empty field and does not call the server', async () => {
    renderApp(<LoginForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findAllByText('This field is required')).toHaveLength(2);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('This field is required');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('validates the email format, clears the error once fixed', async () => {
    renderApp(<LoginForm />);
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Email'));
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await waitFor(() =>
      expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument(),
    );
  });

  it('wrong credentials show one alert, right ones go to the role home', async () => {
    signIn.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 400, message: 'Invalid login credentials' },
    });
    renderApp(<LoginForm />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
    signIn.mockResolvedValueOnce({
      data: { user: { app_metadata: { role: 'dispatcher' } } },
      error: null,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dispatcher'));
  });

  it('works with the keyboard only: Tab order and Enter submits', async () => {
    signIn.mockResolvedValue({ data: { user: { app_metadata: { role: 'sender' } } }, error: null });
    renderApp(<LoginForm />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByLabelText('Email')).toHaveFocus();
    await user.keyboard('a@b.co');
    await user.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await user.keyboard('secret{Enter}');
    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith({ email: 'a@b.co', password: 'secret' }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sender'));
  });

  it('is translated and has no accessibility violations', async () => {
    const { container } = renderApp(<LoginForm />, 'uk');
    expect(screen.getByLabelText('Електронна пошта')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('create-delivery form', () => {
  const fill = async (over: Partial<Record<string, string>> = {}) => {
    const v = {
      name: 'Olena Kovalenko',
      phone: '0671234567',
      city: 'Kyiv',
      street: 'Khreshchatyk',
      house: '22',
      weight: '1,5',
      ...over,
    };
    const u = userEvent.setup();
    for (const [label, value] of [
      ['Full name', v.name],
      ['Phone', v.phone],
      ['City', v.city],
      ['Street', v.street],
      ['House', v.house],
      ['Weight, kg', v.weight],
    ] as const) {
      if (value) await u.type(screen.getByLabelText(label), value);
    }
    return u;
  };

  it('every invalid field gets its own message right next to it, the first one is focused, nothing is sent', async () => {
    renderApp(<CreateDeliveryForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Create delivery' }));
    for (const label of ['Full name', 'Phone', 'City', 'Street', 'House', 'Weight, kg']) {
      const input = screen.getByLabelText(label);
      expect(input, label).toHaveAttribute('aria-invalid', 'true');
      expect(input, label).toHaveAccessibleDescription('This field is required');
    }
    expect(screen.getByLabelText('Full name')).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('range and format errors name the problem; a message disappears once its field is fixed', async () => {
    renderApp(<CreateDeliveryForm />);
    const u = await fill({ weight: '31', phone: '12' });
    await u.type(screen.getByLabelText('Cash on delivery, ₴'), 'lots');
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    expect(await screen.findByText('Weight must be between 0.001 and 30 kg')).toBeInTheDocument();
    expect(screen.getByText('Enter a phone number like +380 67 123 45 67')).toBeInTheDocument();
    expect(screen.getByLabelText('Cash on delivery, ₴')).toHaveAccessibleDescription(/not valid/);
    await u.clear(screen.getByLabelText('Weight, kg'));
    await u.type(screen.getByLabelText('Weight, kg'), '2');
    await waitFor(() =>
      expect(screen.queryByText('Weight must be between 0.001 and 30 kg')).not.toBeInTheDocument(),
    );
  });

  it('the price is recalculated by the server as you type, and the form shows exactly that', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { zone: string; weightG: number; codKop: number };
      return jsonResponse({
        feeKop: 6000 + 800 * Math.max(0, Math.ceil(b.weightG / 1000) - 1),
        codCommissionKop: b.codKop ? Math.max(2000, Math.round(b.codKop * 0.02)) : 0,
        totalKop: 0,
      });
    });
    renderApp(<CreateDeliveryForm />);
    const u = userEvent.setup();
    expect(screen.getByText('Enter the zone and weight to see the price.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Weight, kg'), '2,5');
    expect(await screen.findByTestId('quote')).toHaveTextContent('₴76.00'); // 60 + 2 × 8 = 76 UAH
    await u.type(screen.getByLabelText('Cash on delivery, ₴'), '1000');
    await waitFor(() => expect(screen.getByTestId('quote')).toHaveTextContent('₴20.00')); // 2 % of 1000 UAH = 20 UAH (minimum)
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies.at(-1)).toEqual({ zone: 'A', weightG: 2500, codKop: 100_000 });
    // invalid weight → no request, price hint comes back
    await u.clear(screen.getByLabelText('Weight, kg'));
    await u.type(screen.getByLabelText('Weight, kg'), '99');
    await waitFor(() => expect(screen.queryByTestId('quote')).not.toBeInTheDocument());
  });

  it('submits once even if clicked twice, with a stable Idempotency-Key, then opens the new delivery', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/deliveries/quote'))
        return Promise.resolve(jsonResponse({ feeKop: 6800, codCommissionKop: 0, totalKop: 6800 }));
      return new Promise<Response>((r) => (resolve = r));
    });
    renderApp(<CreateDeliveryForm />);
    const u = await fill();
    const submit = screen.getByRole('button', { name: 'Create delivery' });
    await u.click(submit);
    await u.click(screen.getByRole('button', { name: 'Creating…' })).catch(() => undefined);
    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit).method === 'POST' && String(c[0]).endsWith('/deliveries'),
    );
    expect(posts).toHaveLength(1);
    const headers = (posts[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^web-[0-9a-f-]{36}$/);
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    resolve(jsonResponse({ id: 'abc', number: 'DLV-000001' }, 201));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/sender/abc?created=1'));
  });

  it('after a failure the retry re-uses the same Idempotency-Key', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/quote')
        ? jsonResponse({ feeKop: 1, codCommissionKop: 0, totalKop: 1 })
        : jsonResponse({ error: { code: 'INTERNAL', message: 'x' } }, 500),
    );
    renderApp(<CreateDeliveryForm />);
    const u = await fill();
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          (c) => String(c[0]).endsWith('/deliveries') && (c[1] as RequestInit).method === 'POST',
        ),
      ).toHaveLength(2),
    );
    const keys = fetchMock.mock.calls
      .filter(
        (c) => String(c[0]).endsWith('/deliveries') && (c[1] as RequestInit).method === 'POST',
      )
      .map((c) => ((c[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
    expect(new Set(keys).size).toBe(1);
  });

  it('server-side field errors are shown at the right field', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/quote')
        ? jsonResponse({ feeKop: 1, codCommissionKop: 0, totalKop: 1 })
        : jsonResponse(
            {
              error: {
                code: 'VALIDATION_FAILED',
                message: 'Validation failed',
                details: { fields: { recipientPhone: 'invalid phone number' } },
              },
            },
            400,
          ),
    );
    renderApp(<CreateDeliveryForm />);
    const u = await fill({ phone: '+380671234567' });
    await u.click(screen.getByRole('button', { name: 'Create delivery' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Phone')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByLabelText('Phone')).toHaveAccessibleDescription(/not valid/);
  });

  it('is fully translated, groups fields in labelled fieldsets, and has no accessibility violations', async () => {
    const { container } = renderApp(<CreateDeliveryForm />, 'uk');
    expect(screen.getByRole('button', { name: 'Створити доставку' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Адреса' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Посилка' })).getByLabelText('Вага, кг'),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
