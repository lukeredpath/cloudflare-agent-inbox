// A small approximation of the Public Suffix List: the multi-part suffixes and shared
// hosting domains where unrelated parties each get a name under the same parent. It is
// not the full list, but it covers the cases that matter for alignment checks.
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk", "sch.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in", "co.za", "com.br", "com.cn", "com.mx", "com.tr",
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "herokuapp.com", "vercel.app", "netlify.app",
  "blogspot.com", "appspot.com", "cloudfront.net", "azurewebsites.net", "web.app", "firebaseapp.com",
]);

export function isPublicSuffix(domain: string): boolean {
  return domain.split(".").length < 2 || PUBLIC_SUFFIXES.has(domain);
}

/** True if `domain` is `parent` or a subdomain of it. */
export function isSameOrParent(parent: string, domain: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Relaxed alignment: both names share a registrable (organisational) domain. Names that
 * only share a public suffix, such as two different github.io sites, are not aligned.
 */
export function sameOrganisation(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.split(".").reverse();
  const lb = b.split(".").reverse();
  let shared = 0;
  while (shared < la.length && shared < lb.length && la[shared] === lb[shared]) shared++;
  if (shared < 2) return false;
  return !isPublicSuffix(la.slice(0, shared).reverse().join("."));
}
