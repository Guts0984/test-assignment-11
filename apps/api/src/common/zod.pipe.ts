import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { appError } from '../domain/errors';

/** Validates and transforms input with a Zod schema; failures become a field-level 400. */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    const fields: Record<string, string> = {};
    const issues = r.error.issues.map((i) => {
      const path = i.path.map(String).join('.');
      if (!(path in fields)) fields[path] = i.message;
      return { path, message: i.message };
    });
    throw appError('VALIDATION_FAILED', 'Validation failed', { issues, fields });
  }
}

export const zod = <T>(schema: ZodType<T>) => new ZodPipe(schema);
