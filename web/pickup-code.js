// Demo-only input handling. Real pickup credentials require station-specific rules and encrypted storage.
export function parseDemoPickupCode(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toUpperCase().replace(/[－—–]/g, '-');
  if (!value.startsWith('TEST-')) return null;
  const code = value.slice(5);
  if (/^\d{1,3}-[1-9]-\d{4}$/.test(code)) return { value, kind: 'shelf' };
  if (/^\d{4,12}$/.test(code)) return { value, kind: 'digits' };
  if (/^[A-Z0-9]{4,12}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code)) return { value, kind: 'mixed' };
  return null;
}
