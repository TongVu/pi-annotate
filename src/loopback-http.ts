import type { IncomingHttpHeaders, ServerResponse } from "node:http";

export function setLocalPageHeaders(res: ServerResponse, { embeddedImages = false } = {}) {
  const images = embeddedImages ? "'self' data: blob:" : "'self'";
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src ${images}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
}

export function isLocalRequest(headers: IncomingHttpHeaders, origin: string) {
  return headers.host === new URL(origin).host &&
    (!headers.origin || headers.origin === origin) &&
    headers["sec-fetch-site"] !== "cross-site";
}

export function isSameOriginJson(headers: IncomingHttpHeaders, origin: string) {
  return headers.origin === origin && headers["content-type"] === "application/json";
}
