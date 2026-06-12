import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAllowed } from "@/lib/allowlist";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/",
  "/api/cron/",
  "/api/ingest/", // machine-caller (SMS bridge); guarded by its own bearer token, not session

  "/manifest.webmanifest",
  "/_next/",
  "/favicon.ico",
];

const ICON_PATH = /^\/icons\//;

function isPublic(pathname: string): boolean {
  if (ICON_PATH.test(pathname)) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function applySecurityHeaders(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return applySecurityHeaders(NextResponse.next());
  }

  // Fetch the session from better-auth by passing the incoming request.
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  if (!isAllowed(session.user.email)) {
    return applySecurityHeaders(new NextResponse("Forbidden", { status: 403 }));
  }

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next.js internals and static files.
     * Public paths are checked inside the handler.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
