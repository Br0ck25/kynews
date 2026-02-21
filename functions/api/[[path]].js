export async function onRequest(context) {
  const workerOrigin = context.env.API_ORIGIN || "https://ky-news-worker.jamesbrock25.workers.dev";

  const rawPath = context.params?.path;
  const path = Array.isArray(rawPath) ? rawPath.join("/") : String(rawPath || "");

  const incomingUrl = new URL(context.request.url);
  const upstreamUrl = new URL(`/api/${path}`, workerOrigin);
  upstreamUrl.search = incomingUrl.search;

  const headers = new Headers(context.request.headers);
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));

  const init = {
    method: context.request.method,
    headers,
    redirect: "follow"
  };

  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    init.body = context.request.body;
  }

  const upstream = await fetch(upstreamUrl.toString(), init);

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("x-api-proxy", "pages-function");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}
