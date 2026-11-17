import { describe, expect, it } from 'vitest';
import {
  collectSignOutWarnings,
  onBeforeSignOut,
  onSignOutWarning,
  runSignOutHooks,
} from './sign-out';

describe('sign-out hooks', () => {
  it('runs every registered cleanup, also when one fails, and unregisters', async () => {
    const calls: string[] = [];
    const off1 = onBeforeSignOut(() => void calls.push('a'));
    const off2 = onBeforeSignOut(async () => {
      throw new Error('boom');
    });
    const off3 = onBeforeSignOut(async () => void calls.push('c'));
    await runSignOutHooks();
    expect(calls.sort()).toEqual(['a', 'c']);
    off1();
    off2();
    off3();
    calls.length = 0;
    await runSignOutHooks();
    expect(calls).toEqual([]);
  });
});

describe('sign-out warnings', () => {
  it('collects non-empty messages from sync and async providers, skips null and failing ones, and unregisters', async () => {
    expect(await collectSignOutWarnings()).toEqual([]);
    const offs = [
      onSignOutWarning(() => 'one'),
      onSignOutWarning(async () => 'two'),
      onSignOutWarning(() => null),
      onSignOutWarning(async () => {
        throw new Error('boom');
      }),
    ];
    expect((await collectSignOutWarnings()).sort()).toEqual(['one', 'two']);
    offs.forEach((off) => off());
    expect(await collectSignOutWarnings()).toEqual([]);
  });
});
