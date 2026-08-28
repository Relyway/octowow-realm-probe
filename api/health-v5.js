function isAuthorized(request) {
  const expected =
    process.env.PROBE_TOKEN;

  // Пока PROBE_TOKEN не задан,
  // endpoint открыт для первоначального теста.
  if (!expected) {
    return true;
  }

  const received =
    request.headers.authorization || "";

  return (
    received ===
    `Bearer ${expected}`
  );
}

export default async function handler(
  request,
  response
) {
  response.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  if (request.method !== "GET") {
    return response.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  if (!isAuthorized(request)) {
    return response.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  return response.status(200).json({
    ok: true,
    service:
      "octowow-realm-probe-v5",
    checkedAt:
      new Date().toISOString(),
  });
}
