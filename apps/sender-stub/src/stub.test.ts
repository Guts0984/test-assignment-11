import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createStub, verifySignature, type RunningStub } from './stub';

let stub: RunningStub;
beforeAll(async () => {
  stub = await createStub({ secret: 'secret-secret' });
});
afterAll(() => stub.close());

const sign = (id: string, ts: string, body: string) =>
  `v1=${createHmac('sha256', 'secret-secret').update(`${id}.${ts}.${body}`).digest('hex')}`;
const post = (body: string, headers: Record<string, string>) =>
  fetch(`${stub.url}/hook`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const setMode = (mode: string) =>
  fetch(`${stub.url}/api/mode`, { method: 'POST', body: JSON.stringify({ mode }) });

describe('sender stub', () => {
  it('records notifications and flags a bad signature', async () => {
    const body = JSON.stringify({ event: 'created', number: 'DLV-000001' });
    const good = await post(body, {
      'Webhook-Id': 'a',
      'Webhook-Timestamp': '1',
      'Webhook-Signature': sign('a', '1', body),
    });
    const bad = await post(body, {
      'Webhook-Id': 'b',
      'Webhook-Timestamp': '1',
      'Webhook-Signature': 'v1=00',
    });
    const none = await post(body, {});
    expect([good.status, bad.status, none.status]).toEqual([200, 200, 200]);
    expect(stub.state.received.map((r) => r.signatureValid)).toEqual([true, false, false]);
    const list = (await (await fetch(`${stub.url}/api/received`)).json()) as {
      received: unknown[];
    };
    expect(list.received).toHaveLength(3);
  });

  it('verifySignature rejects different lengths and tampering', () => {
    const body = '{}';
    expect(verifySignature('secret-secret', 'a', '1', body, sign('a', '1', body))).toBe(true);
    expect(verifySignature('secret-secret', 'a', '1', body, 'v1=')).toBe(false);
    expect(verifySignature('secret-secret', 'a', '2', body, sign('a', '1', body))).toBe(false);
  });

  it('error mode answers 500, hang mode never answers, switching back releases hung requests', async () => {
    await setMode('error');
    expect((await post('{}', {})).status).toBe(500);
    await setMode('hang');
    const hung = post('{}', {}).then(
      () => 'answered',
      () => 'dropped',
    );
    expect(
      await Promise.race([hung, new Promise((r) => setTimeout(() => r('still waiting'), 400))]),
    ).toBe('still waiting');
    await setMode('ok');
    expect(await hung).toBe('dropped');
    expect((await post('{}', {})).status).toBe(200);
  });

  it('rejects unknown modes, serves the page, and can be cleared', async () => {
    expect((await setMode('explode')).status).toBe(400);
    const html = await (await fetch(`${stub.url}/`)).text();
    expect(html).toContain('Do not answer');
    expect(html).toContain('<script>'.slice(0, 0) + 'Sender stub');
    await fetch(`${stub.url}/api/reset`, { method: 'POST' });
    expect(stub.state.received).toHaveLength(0);
    expect((await fetch(`${stub.url}/nope`)).status).toBe(404);
    expect((await fetch(`${stub.url}/health`)).status).toBe(200);
  });

  it('escapes hostile content in the page', async () => {
    await post(JSON.stringify({ event: '<img src=x onerror=alert(1)>' }), {
      'Webhook-Id': '"><script>x</script>',
    });
    const html = await (await fetch(`${stub.url}/`)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"><script>x');
  });
});
