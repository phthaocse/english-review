// Where the call to Google leaves from.
//
// Gemini is not offered in every country, and a Worker runs wherever the
// request lands: from Vietnam that is Hong Kong about half the time, which
// Google refuses with "This API is not available in your current location".
// A Durable Object can be pinned to a region, so the call goes out from one
// Google does serve.
//
// The hint is best effort, and the first one tried came back blocked in
// production, so each relay now reports the data centre it actually sits in
// and that goes in the log next to the attempt.

// enam is first because it is the one observed serving real reads. The extra
// few hundred milliseconds to North America is nothing against a model that
// takes 30 to 80 seconds to answer.
export const REGIONS = ['enam', 'apac-ne'];

// Bumping this re-rolls every relay's placement: the hint is only honoured when
// the object is created, so a blocked one is escaped by asking for a new name.
const GENERATION = 2;

/** A relay that does nothing but make the request from where it lives. */
export class RegionalFetcher {
  #colo = null;

  /** Cached for the object's lifetime: the answer cannot change under it. */
  async #where() {
    if (this.#colo) return this.#colo;
    try {
      const trace = await fetch('https://workers.cloudflare.com/cdn-cgi/trace').then((r) => r.text());
      this.#colo = /colo=(\w+)/.exec(trace)?.[1] || '?';
    } catch {
      this.#colo = '?';
    }
    return this.#colo;
  }

  async fetch(request) {
    const target = request.headers.get('x-target');
    if (!target) return new Response('no x-target header', { status: 400 });

    const headers = new Headers(request.headers);
    headers.delete('x-target');
    const [res, colo] = await Promise.all([
      fetch(target, { method: request.method, headers, body: request.body }),
      this.#where(),
    ]);

    const out = new Response(res.body, res);
    out.headers.set('x-relay-colo', colo);
    return out;
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
    const stub = env.REGION.get(env.REGION.idFromName(`${region}:${GENERATION}`),
                                { locationHint: region });
    return stub.fetch('https://region/call', {
      method: init.method || 'GET',
      headers: { ...(init.headers || {}), 'x-target': url },
      body: init.body,
      signal: init.signal,
    });
  };
}
