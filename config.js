// Public configuration. Nothing secret belongs here — this file ships to the
// browser. The OAuth client ID identifies the app; it does not authorise
// anything, and the Gemini key lives only in the Worker.
export const CONFIG = {
  googleClientId: 'REPLACE_ME.apps.googleusercontent.com',
  apiBase: 'https://knowledge-api.REPLACE_ME.workers.dev',
};
