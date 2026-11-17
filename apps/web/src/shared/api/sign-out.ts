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
