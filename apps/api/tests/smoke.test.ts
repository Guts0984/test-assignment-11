import { describe, expect, it } from 'vitest';
import { call, makeActors, useHarness, createViaApi } from './harness';

const h = useHarness();

describe('smoke', () => {
  it('health, auth and a create round trip', async () => {
    expect((await call(h, 'GET', '/health')).status).toBe(200);
    const a = await makeActors(h.sql);
    const me = await call<{ role: string }>(h, 'GET', '/me', { token: a.sender.accessToken });
    expect(me.body.role).toBe('sender');
    const d = await createViaApi(h, a.sender.accessToken);
    expect(d.number).toMatch(/^DLV-\d{6,}$/);
    expect(d.totalKop).toBe(6000 + 800);
    const doc = await call(h, 'GET', '/docs-json');
    expect(doc.status).toBe(200);
  });
});
