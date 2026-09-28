// Where the call to Google leaves from.
//
// Gemini is not offered in every country, and a Worker runs wherever the
// request lands: from Vietnam that is Hong Kong about half the time, which
// Google refuses with "This API is not available in your current location".
// A Durable Object can be pinned to a region, so the call goes out from one
// Google does serve. Measured 2026-09-28: apac-se lands in Singapore,
// apac-ne in Seoul, enam in Miami; all three are on Google's list.

export const REGIONS = ['apac-se', 'enam'];

/** A relay that does nothing but make the request from where it lives. */
export class RegionalFetcher {
  async fetch(request) {
    const target = request.headers.get('x-target');
    if (!target) return new Response('no x-target header', { status: 400 });

    const headers = new Headers(request.headers);
    headers.delete('x-target');
    return fetch(target, { method: request.method, headers, body: request.body });
  }
}

/**
 * A `fetch` that goes through the relay in `region`.
 *
 * The body is passed through as-is rather than wrapped: a photo is around a
 * megabyte of base64, and re-encoding it into an envelope would copy it twice.
 */
export function viaRegion(env, region) {
  if (!env.REGION) return (...args) => fetch(...args);   // no binding: call directly

  return (url, init = {}) => {
    // The hint only applies when the object is created, so each region keeps
    // its own long-lived object under its own name.
    const stub = env.REGION.get(env.REGION.idFromName(region), { locationHint: region });
    return stub.fetch('https://region/call', {
      method: init.method || 'GET',
      headers: { ...(init.headers || {}), 'x-target': url },
      body: init.body,
      signal: init.signal,
    });
  };
}
