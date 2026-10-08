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
export async function api(path, { method = 'GET', body, signal, binary = false } = {}) {
  await connectSession();
  const headers = { 'X-Yunus-Token': token };
  if (body !== undefined) headers['Content-Type'] = binary ? 'audio/wav' : 'application/json';
  const response = await fetch(path, { method, headers, signal, cache: 'no-store', credentials: 'same-origin', body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : `Request failed (${response.status}). Try again.`;
    throw new Error(reason.slice(0, 300));
  }
  return data;
}
