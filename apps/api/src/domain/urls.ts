/**
 * The API talks to Supabase on an internal address (inside Docker: the host gateway), but every URL it hands to a
 * browser (signed photo URLs) must use the address the browser can reach.
 */
export function toPublicUrl(url: string, internalBase: string, publicBase: string): string {
  const from = internalBase.replace(/\/+$/, '');
  const to = publicBase.replace(/\/+$/, '');
  return url.startsWith(`${from}/`) ? `${to}${url.slice(from.length)}` : url;
}
