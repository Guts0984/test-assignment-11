/**
 * Features that keep personal data on the device (the courier app's cached list) register a cleanup here; the sign-out
 * button runs them all before ending the session. A registry (instead of an import) keeps features independent.
 */
type Hook = () => Promise<void> | void;
const hooks = new Set<Hook>();

export function onBeforeSignOut(hook: Hook): () => void {
  hooks.add(hook);
  return () => void hooks.delete(hook);
}

/** Runs every registered cleanup. One failing cleanup never prevents signing out. */
export async function runSignOutHooks(): Promise<void> {
  await Promise.allSettled([...hooks].map(async (h) => h()));
}

/**
 * A warning provider tells the sign-out button that signing out loses something (e.g. actions still waiting to be
 * sent). It returns the text to show, or null when there is nothing to warn about.
 */
type WarningProvider = () => string | null | Promise<string | null>;
const providers = new Set<WarningProvider>();

export function onSignOutWarning(fn: WarningProvider): () => void {
  providers.add(fn);
  return () => void providers.delete(fn);
}

/** Every current warning. A provider that throws is skipped: it must never block signing out. */
export async function collectSignOutWarnings(): Promise<string[]> {
  const out = await Promise.allSettled([...providers].map(async (p) => p()));
  return out.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}
