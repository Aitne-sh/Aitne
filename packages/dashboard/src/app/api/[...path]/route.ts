import type { NextRequest } from "next/server";
import { evaluateProxyGate } from "@/lib/proxy-gate";
import {
  redactProxyErrorMessage,
  resolveDaemonApiToken,
} from "@/lib/daemon-api-token";
import { buildUpstreamUrl } from "@/lib/proxy-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getDaemonBaseUrl(): string {
  return process.env.PA_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8321";
}

async function proxyToDaemon(request: NextRequest): Promise<Response> {
  // CSRF gate — block before we attach the daemon's Bearer token. A
  // request that doesn't pass this check would otherwise inherit our
  // token and run as the dashboard owner, even if it originated from a
  // malicious site or via DNS rebinding.
  const decision = evaluateProxyGate({
    method: request.method,
    expectedOrigin: request.nextUrl.origin,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    host: request.headers.get("host"),
  });
  if (!decision.allowed) {
    return Response.json(
      {
        error: "forbidden_origin",
        reason: decision.reason,
        message:
          "This request did not pass the dashboard proxy's CSRF gate.",
      },
      { status: 403 },
    );
  }

  // See `buildUpstreamUrl` for why we use the raw pathname rather than
  // `ctx.params.path` — Next.js decodes %2F in catch-all params, which
  // breaks IDs of the form `github:owner/repo`.
  const upstreamUrl = buildUpstreamUrl(request.nextUrl, getDaemonBaseUrl());

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-caller", "dashboard");

  try {
    const apiToken = await resolveDaemonApiToken();
    if (apiToken) {
      headers.set("authorization", `Bearer ${apiToken}`);
    }

    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : Buffer.from(await request.arrayBuffer()),
      redirect: "manual",
      cache: "no-store",
    });

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = redactProxyErrorMessage(
      error instanceof Error ? error.message : "Unknown proxy error",
    );
    return Response.json(
      { error: "daemon_unreachable", message },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  return proxyToDaemon(request);
}

export async function POST(request: NextRequest) {
  return proxyToDaemon(request);
}

export async function PUT(request: NextRequest) {
  return proxyToDaemon(request);
}

export async function PATCH(request: NextRequest) {
  return proxyToDaemon(request);
}

export async function DELETE(request: NextRequest) {
  return proxyToDaemon(request);
}
