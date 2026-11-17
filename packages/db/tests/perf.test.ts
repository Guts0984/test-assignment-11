import { describe, expect, it } from 'vitest';
import { useDb } from './db';
import { DEMO } from '../src/testing/users';

const { sql } = useDb(5);

/** p95 of `runs` executions, in ms, after one warm-up. */
async function p95(run: () => Promise<unknown>, runs = 20): Promise<{ p95: number; max: number }> {
  await run();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await run();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return { p95: t[Math.ceil(runs * 0.95) - 1]!, max: t.at(-1)! };
}

const BUDGET_MS = 300;
const sender = DEMO.senderId(1);

// The queries below are the ones apps/api runs for the board, the report and the sender list.
describe(`query performance on the 50 000-row seed (budget ${BUDGET_MS} ms, p95 of 20 runs)`, () => {
  it('dispatcher board: queue per zone', async () => {
    const r = await p95(
      () => sql`select zone, status, count(*)::int n from public.deliveries
        where status in ('created', 'failed_attempt') group by zone, status`,
    );
    console.info('board queue', r);
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('dispatcher board: queue list (oldest first, per zone)', async () => {
    const r = await p95(
      () => sql`select id, public_number, zone, status, created_at, next_attempt_at from public.deliveries
        where status in ('created', 'failed_attempt') and zone = 'B' order by created_at limit 50`,
    );
    console.info('board queue list', r);
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('dispatcher board: couriers with load n/8 and shift state', async () => {
    const r = await p95(
      () => sql`select c.user_id, p.full_name, (s.id is not null) as on_shift, count(d.id)::int as active
        from public.couriers c join public.profiles p on p.user_id = c.user_id
        left join public.shifts s on s.courier_id = c.user_id and s.closed_at is null
        left join public.deliveries d on d.courier_id = c.user_id and d.status in ('assigned', 'picked_up')
        group by c.user_id, p.full_name, s.id order by p.full_name`,
    );
    console.info('board couriers', r);
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('report for 90 days: delivered, failures by reason, mean assign→deliver, cash discrepancies', async () => {
    const from = new Date(Date.now() - 90 * 86400_000);
    const r = await p95(async () => {
      await Promise.all([
        sql`select count(*)::int delivered, avg(extract(epoch from delivered_at - assigned_at))::float avg_seconds
            from public.deliveries where status = 'delivered' and delivered_at >= ${from} and delivered_at < now()`,
        sql`select payload->>'reason' reason, count(*)::int n from public.delivery_events
            where type = 'failed_attempt' and server_time >= ${from} and server_time < now() group by 1 order by 2 desc`,
        sql`select count(*)::int shifts, sum(discrepancy_kop)::bigint total, sum(abs(discrepancy_kop))::bigint abs_total,
              count(*) filter (where discrepancy_kop <> 0)::int with_discrepancy
            from public.shifts where closed_at >= ${from} and closed_at < now()`,
      ]);
    });
    console.info('report 90d', r);
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('sender list: filters by status and date, ordered, with total', async () => {
    const from = new Date(Date.now() - 60 * 86400_000);
    const r = await p95(async () => {
      await sql`select id, public_number, status, created_at from public.deliveries
        where sender_id = ${sender} and status = any(${['delivered', 'failed_attempt']}::public.delivery_status[])
          and created_at >= ${from} order by created_at desc, id limit 20 offset 40`;
      await sql`select count(*)::int from public.deliveries
        where sender_id = ${sender} and status = any(${['delivered', 'failed_attempt']}::public.delivery_status[]) and created_at >= ${from}`;
    });
    console.info('sender list', r);
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('sender search by number and by phone', async () => {
    const [row] =
      await sql`select number, recipient_phone from public.deliveries where sender_id = ${sender} limit 1 offset 500`;
    const r = await p95(async () => {
      await sql`select id from public.deliveries where sender_id = ${sender} and number = ${row!.number}`;
      await sql`select id from public.deliveries where sender_id = ${sender} and recipient_phone = ${row!.recipient_phone} order by created_at desc limit 20`;
      await sql`select id from public.deliveries where sender_id = ${sender} and recipient_phone like ${row!.recipient_phone.slice(0, 9) + '%'} order by created_at desc limit 20`;
    });
    console.info('sender search', r);
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('courier day list', async () => {
    const r = await p95(
      () => sql`select id, public_number, status, address from public.deliveries
        where courier_id = ${DEMO.courierId(3)} and status in ('assigned', 'picked_up') order by assigned_at`,
    );
    expect(r.p95).toBeLessThan(BUDGET_MS);
  });

  it('the planner really uses indexes for the hot paths (no sequential scan of deliveries)', async () => {
    const plans: string[] = [];
    for (const q of [
      `select 1 from public.deliveries where status in ('created','failed_attempt') and zone = 'A' order by created_at limit 50`,
      `select 1 from public.deliveries where sender_id = '${sender}' order by created_at desc limit 20`,
      `select 1 from public.deliveries where courier_id = '${DEMO.courierId(3)}' and status in ('assigned','picked_up')`,
      `select 1 from public.deliveries where status = 'assigned' and assigned_at <= now() - interval '45 minutes'`,
    ]) {
      const rows = await sql.unsafe(`explain ${q}`);
      plans.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
    }
    for (const p of plans) expect(p).not.toMatch(/Seq Scan on deliveries/);
  });
});
