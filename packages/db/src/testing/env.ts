import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Walk up from cwd to the repo root (the folder holding pnpm-workspace.yaml). */
export function repoRoot(from: string = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('repo root not found');
}

/** Loads .env, falling back to .env.example (its values are the local-supabase defaults). Never overrides real env. */
export function loadTestEnv(): void {
  const root = repoRoot();
  for (const f of ['.env', '.env.example']) {
    const p = resolve(root, f);
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}

export type TestEnv = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
  databaseUrl: string;
};

export function testEnv(): TestEnv {
  loadTestEnv();
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env var ${k}`);
    return v;
  };
  return {
    supabaseUrl: need('SUPABASE_URL'),
    anonKey: need('SUPABASE_ANON_KEY'),
    serviceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),
    jwtSecret: need('SUPABASE_JWT_SECRET'),
    databaseUrl: need('DATABASE_URL'),
  };
}
