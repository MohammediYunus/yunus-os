// The local session token lives only in this module's memory.
let token = null;
let sessionPromise = null;
export async function connectSession() {
  if (token) return;
  if (!sessionPromise) sessionPromise = (async () => {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not connect to the local server. Restart Yunus OS and try again.');
    const session = await response.json();
    if (typeof session.token !== 'string' || !session.token) throw new Error('The local session is unavailable. Reload this page.');
    token = session.token;
  })().finally(() => { sessionPromise = null; });
  return sessionPromise;
}
export async function api(path, { method = 'GET', body = method === 'DELETE' ? {} : undefined, signal, binary = false, responseType = 'json' } = {}) {
  await connectSession();
  const payload = body === undefined ? undefined : binary ? body : JSON.stringify(body);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const requestToken = token, headers = { 'X-Yunus-Token': requestToken };
    if (body !== undefined) headers['Content-Type'] = binary ? 'audio/wav' : 'application/json';
    const response = await fetch(path, { method, headers, signal, cache: 'no-store', credentials: 'same-origin', body: payload });
    if (response.ok && responseType === 'blob') return response.blob();
    const data = await response.json().catch(() => ({}));
    if (attempt === 0 && response.status === 401 && data.code === 'LOCAL_SESSION_EXPIRED') {
      signal?.throwIfAborted();
      // This marker is returned before route handlers run, so a write was not applied.
      // A delayed rejection must not discard a newer token obtained by another request.
      if (token === requestToken) token = null;
      await connectSession();
      continue;
    }
    if (!response.ok) {
      const reason = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : `Request failed (${response.status}). Try again.`;
      throw new Error(reason.slice(0, 300));
    }
    return data;
  }
}
