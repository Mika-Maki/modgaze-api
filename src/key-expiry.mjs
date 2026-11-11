// MR (virtual) key deadlines are absolute instants, never server-local dates.
// null / empty means no expiry. The WebUI converts its displayed local time to UTC.
export function normalizeMRExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid MR Expires at: expected an ISO timestamp with timezone');
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]{1,3}))?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match) throw new Error('Invalid MR Expires at: expected an ISO timestamp with timezone');
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month), 0);
  const valid = Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= calendar.getUTCDate()
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
  const time = Date.parse(value);
  if (!valid || !Number.isFinite(time)) throw new Error('Invalid MR Expires at: invalid calendar date');
  return new Date(time).toISOString();
}

// Evaluate at creation inside the configuration queue, not when the HTTP body
// first arrives: a queued request may outlive its proposed expiry.
export function normalizeNewMRExpiresAt(value, now = Date.now()) {
  const expiresAt = normalizeMRExpiresAt(value);
  if (expiresAt !== null && Date.parse(expiresAt) <= now) {
    throw new Error('Invalid MR Expires at: new keys require a future expiry');
  }
  return expiresAt;
}
