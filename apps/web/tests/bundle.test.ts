import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '.next');
const built = existsSync(join(root, 'static'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Needs `next build` first (CI builds before testing). Without a build there is nothing to scan, and that is said loudly.
describe.skipIf(!built)('client bundle never contains server secrets', () => {
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    readFileSync(join(__dirname, '../../../.env.example'), 'utf8').match(
      /^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m,
    )?.[1] ??
    ''
  ).trim();
  const files = built
    ? walk(join(root, 'static')).filter((f) => /\.(js|css|map|html|json)$/.test(f))
    : [];

  it('has client files to scan', () => expect(files.length).toBeGreaterThan(10));
  it('does not contain the service-role key', () => {
    expect(serviceKey.length).toBeGreaterThan(40);
    const leaks = files.filter((f) => readFileSync(f, 'utf8').includes(serviceKey));
    expect(leaks).toEqual([]);
  });
  it('does not mention the service role variable or the webhook secrets', () => {
    const bad = files.filter((f) =>
      /SUPABASE_SERVICE_ROLE_KEY|service_role|whsec_|SUPABASE_JWT_SECRET|DATABASE_URL/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(bad).toEqual([]);
  });
  it('only the anon key is embedded', () => {
    const jwtRoles = new Set<string>();
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(
        /eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g,
      )) {
        jwtRoles.add(JSON.parse(Buffer.from(m[1]!, 'base64url').toString()).role);
      }
    }
    expect([...jwtRoles].filter((r) => r !== 'anon')).toEqual([]);
  });
});
