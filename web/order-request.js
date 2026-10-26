const fallback = new Map();

export function prepareOrderRequest(storage, key, draft, createId) {
  const fingerprint = JSON.stringify(draft);
  let previous;
  try { previous = JSON.parse(storage.getItem(key)) || fallback.get(key); } catch { previous = fallback.get(key); }
  const requestId = previous?.fingerprint === fingerprint && /^[a-zA-Z0-9-]{8,64}$/.test(previous.requestId)
    ? previous.requestId : createId();
  const next = { fingerprint, requestId };
  fallback.set(key, next);
  try { storage.setItem(key, JSON.stringify(next)); } catch {}
  return requestId;
}

export function clearOrderRequest(storage, key) {
  fallback.delete(key);
  try { storage.removeItem(key); } catch {}
}
