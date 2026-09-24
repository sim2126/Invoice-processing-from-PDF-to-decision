import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const base = process.env.API_INTERNAL_URL || "http://localhost:8005";
  const url = `${base}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const headers = new Headers();
  for (const name of [
    "cookie",
    "content-type",
    "origin",
    "x-csrf-token",
    "last-event-id",
    "accept",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Node fetch streams the upload. Neither upload nor SSE is buffered here.
      ...(hasBody ? { duplex: "half" } : {}),
      signal: request.signal,
      cache: "no-store",
    } as RequestInit);
    const outgoing = new Headers();
    for (const name of [
      "content-type",
      "content-disposition",
      "cache-control",
      "x-accel-buffering",
    ]) {
      const value = upstream.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    for (const cookie of upstream.headers.getSetCookie())
      outgoing.append("set-cookie", cookie);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outgoing,
    });
  } catch {
    return Response.json(
      {
        detail:
          "The review service is unavailable. Your saved work will return when the connection recovers.",
      },
      { status: 503 },
    );
  }
}
export { proxy as GET, proxy as POST, proxy as DELETE };
