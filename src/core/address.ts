const LOCAL_PREFIX = "inbox+";
const TOKEN = /^[a-z2-7]{26,64}$/;

export function buildAddress(token: string, mailHostname: string): string {
  return `${LOCAL_PREFIX}${token}@${mailHostname}`;
}

/** Extracts the lane token from a recipient, or null if it is not a lane address on this host. */
export function parseRecipient(recipient: string, mailHostname: string): string | null {
  const at = recipient.lastIndexOf("@");
  if (at < 1) return null;
  const local = recipient.slice(0, at).toLowerCase();
  const domain = recipient.slice(at + 1).trim().toLowerCase();
  if (domain !== mailHostname.trim().toLowerCase()) return null;
  if (!local.startsWith(LOCAL_PREFIX)) return null;
  const token = local.slice(LOCAL_PREFIX.length);
  return TOKEN.test(token) ? token : null;
}
