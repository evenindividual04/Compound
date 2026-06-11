import { createAuthClient } from "better-auth/client";

// baseURL is omitted — the client uses relative paths to /api/auth/* which
// works for same-origin requests (the only case for this single-user PWA).
export const authClient = createAuthClient();
