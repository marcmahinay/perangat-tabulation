/**
 * JSON request helper. Rejects with an Error carrying the server's message;
 * `error.status` is the HTTP status, `error.network` is true when the server
 * could not be reached at all.
 */
export async function request(method, url, body, token) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const error = new Error('Cannot reach the tabulation server. Check the network connection.');
    error.network = true;
    throw error;
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((payload && payload.error) || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
