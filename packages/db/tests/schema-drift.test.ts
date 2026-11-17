import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable, type PgEnum } from 'drizzle-orm/pg-core';
import { is, getTableName } from 'drizzle-orm';
import { PgTable as PgTableClass } from 'drizzle-orm/pg-core';
import { DELIVERY_STATUSES, PHOTO_KINDS, ROLES, ZONES } from '@courier/shared';
import * as schema from '../src/schema';
import { useDb } from './db';

const { sql } = useDb(5);

const UDT_TO_DRIZZLE: Record<string, string> = {
  int8: 'bigint',
  int4: 'integer',
  int2: 'smallint',
  bool: 'boolean',
  timestamptz: 'timestamp with time zone',
};

const tables: PgTable[] = (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
  is(v, PgTableClass),
);
type AnyEnum = PgEnum<[string, ...string[]]>;
const isPgEnum = (v: unknown): v is AnyEnum =>
  typeof v === 'function' && 'enumName' in v && 'enumValues' in v;
const enums: AnyEnum[] = (Object.values(schema) as unknown[]).filter(isPgEnum);

describe('Drizzle schema vs the live database (catches silent drift)', () => {
  it('declares exactly the tables that exist in public', async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(rows.map((r) => r.table_name).sort());
  });

  for (const table of tables) {
    const cfg = getTableConfig(table);
    it(`table ${cfg.name}: same columns, types and nullability`, async () => {
      const rows = await sql<
        { column_name: string; is_nullable: string; udt_name: string; data_type: string }[]
      >`
        select column_name, is_nullable, udt_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = ${cfg.name}`;
      const db = new Map(rows.map((r) => [r.column_name, r]));
      expect(cfg.columns.map((c) => c.name).sort()).toEqual([...db.keys()].sort());
      for (const col of cfg.columns) {
        const live = db.get(col.name)!;
        const liveType =
          live.data_type === 'USER-DEFINED'
            ? live.udt_name
            : (UDT_TO_DRIZZLE[live.udt_name] ?? live.udt_name);
        expect(col.getSQLType(), `${cfg.name}.${col.name} type`).toBe(liveType);
        const generated = (col as unknown as { generated?: unknown }).generated !== undefined;
        if (!generated) {
          expect(!col.notNull, `${cfg.name}.${col.name} nullability`).toBe(
            live.is_nullable === 'YES',
          );
        }
      }
    });
  }

  for (const e of enums) {
    it(`enum ${e.enumName}: same labels in the same order`, async () => {
      const rows = await sql<{ enumlabel: string }[]>`
        select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = ${e.enumName} order by e.enumsortorder`;
      expect(rows.map((r) => r.enumlabel)).toEqual([...e.enumValues]);
    });
  }

  it('every enum in the database is declared in Drizzle', async () => {
    const rows = await sql<{ typname: string }[]>`
      select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'e'`;
    expect(enums.map((e) => e.enumName).sort()).toEqual(rows.map((r) => r.typname).sort());
  });

  it('enums shared with @courier/shared have identical values', () => {
    expect([...schema.deliveryStatus.enumValues]).toEqual([...DELIVERY_STATUSES]);
    expect([...schema.zone.enumValues]).toEqual([...ZONES]);
    expect([...schema.userRole.enumValues]).toEqual([...ROLES]);
    expect([...schema.photoKind.enumValues]).toEqual([...PHOTO_KINDS]);
  });
});
