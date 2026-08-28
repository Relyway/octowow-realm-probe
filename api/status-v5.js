import http from "node:http";
import https from "node:https";

const REALMS = [
  {
    key: "cthun",
    name: "C'Thun",
    type: "Hardcore",
    namePattern: "C.?Thun",
  },
  {
    key: "nzoth",
    name: "N'Zoth",
    type: "Normal",
    namePattern: "N.?Zoth",
  },
  {
    key: "yshaarj",
    name: "Y'Shaarj",
    type: "PvP",
    namePattern: "Y.?Shaarj",
  },
];

const ALLOWED_HOSTS =
  new Set([
    "octowow.st",
    "www.octowow.st",
  ]);

const RETRY_DELAYS_MS = [
  0,
  1000,
  2500,
];

const REQUEST_TIMEOUT_MS =
  5000;

const MAX_BODY_BYTES =
  2 * 1024 * 1024;

const TLS_CERTIFICATE_ERRORS =
  new Set([
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);

function isAuthorized(request) {
  const expected =
    process.env.PROBE_TOKEN;

  /*
    Пока secret не настроен,
    разрешаем запросы для первоначального теста.

    Позже добавим PROBE_TOKEN в Vercel,
    и endpoint автоматически станет закрытым.
  */
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

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function makeError(
  message,
  code,
  extra = {}
) {
  const error =
    new Error(message);

  error.code = code;

  Object.assign(
    error,
    extra
  );

  return error;
}

function requestPage({
  protocol = "https:",
  hostname = "octowow.st",
  path = "/",
  redirects = 0,
  rejectUnauthorized = true,
} = {}) {
  return new Promise(
    (resolve, reject) => {
      if (redirects > 5) {
        reject(
          makeError(
            "Too many redirects",
            "TOO_MANY_REDIRECTS"
          )
        );

        return;
      }

      if (
        !ALLOWED_HOSTS.has(
          hostname
        )
      ) {
        reject(
          makeError(
            `Unexpected redirect host: ${hostname}`,
            "UNEXPECTED_REDIRECT_HOST"
          )
        );

        return;
      }

      const client =
        protocol === "https:"
          ? https
          : http;

      const options = {
        protocol,
        hostname,

        port:
          protocol === "https:"
            ? 443
            : 80,

        path,

        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/151.0.0.0 Safari/537.36",

          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          "Accept-Language":
            "en-US,en;q=0.9",

          "Accept-Encoding":
            "identity",

          "Cache-Control":
            "no-cache",

          Pragma:
            "no-cache",
        },

        timeout:
          REQUEST_TIMEOUT_MS,
      };

      if (
        protocol === "https:"
      ) {
        options.rejectUnauthorized =
          rejectUnauthorized;

        options.servername =
          hostname;
      }

      const req =
        client.request(
          options,
          (res) => {
            const status =
              res.statusCode || 0;

            if (
              [
                301,
                302,
                303,
                307,
                308,
              ].includes(status) &&
              res.headers.location
            ) {
              res.resume();

              try {
                const current =
                  `${protocol}//${hostname}${path}`;

                const next =
                  new URL(
                    res.headers.location,
                    current
                  );

                resolve(
                  requestPage({
                    protocol:
                      next.protocol,

                    hostname:
                      next.hostname,

                    path:
                      next.pathname +
                      next.search,

                    redirects:
                      redirects + 1,

                    rejectUnauthorized,
                  })
                );
              } catch (error) {
                reject(error);
              }

              return;
            }

            const chunks = [];
            let totalBytes = 0;

            res.on(
              "data",
              (chunk) => {
                totalBytes +=
                  chunk.length;

                if (
                  totalBytes >
                  MAX_BODY_BYTES
                ) {
                  req.destroy(
                    makeError(
                      "OctoWoW response is unexpectedly large",
                      "BODY_TOO_LARGE"
                    )
                  );

                  return;
                }

                chunks.push(
                  chunk
                );
              }
            );

            res.on(
              "end",
              () => {
                resolve({
                  status,

                  body:
                    Buffer.concat(
                      chunks
                    ).toString(
                      "utf8"
                    ),
                });
              }
            );
          }
        );

      req.on(
        "timeout",
        () => {
          req.destroy(
            makeError(
              "OctoWoW request timed out",
              "ETIMEDOUT"
            )
          );
        }
      );

      req.on(
        "error",
        reject
      );

      req.end();
    }
  );
}

function htmlToText(html) {
  return html
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;|&#160;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&#039;|&#39;|&apos;|&rsquo;|&#8217;/gi,
      "'"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /[’‘]/g,
      "'"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function findRealmStatus(
  text,
  realm
) {
  const nameRegex =
    new RegExp(
      realm.namePattern,
      "ig"
    );

  let match;

  while (
    (
      match =
        nameRegex.exec(text)
    ) !== null
  ) {
    const nearby =
      text.slice(
        match.index,
        match.index + 300
      );

    const typeRegex =
      new RegExp(
        `\\b${realm.type}\\b`,
        "i"
      );

    if (
      !typeRegex.test(
        nearby
      )
    ) {
      continue;
    }

    const statusMatch =
      nearby.match(
        /\b(Online|Offline)\b/i
      );

    if (
      !statusMatch
    ) {
      continue;
    }

    return (
      statusMatch[1]
        .toLowerCase() ===
      "online"
        ? "Online"
        : "Offline"
    );
  }

  throw makeError(
    `Could not determine status for ${realm.name} (${realm.type})`,
    "PARSE_ERROR"
  );
}

function parseRealms(html) {
  const text =
    htmlToText(html);

  const result = {};

  for (
    const realm of REALMS
  ) {
    result[realm.key] =
      findRealmStatus(
        text,
        realm
      );
  }

  /*
    Fail closed:
    all three realms must exist
    and have an explicit status.
  */
  for (
    const realm of REALMS
  ) {
    const status =
      result[realm.key];

    if (
      status !== "Online" &&
      status !== "Offline"
    ) {
      throw makeError(
        `Invalid parsed status for ${realm.key}`,
        "PARSE_ERROR"
      );
    }
  }

  return result;
}

function isTlsCertificateError(
  error
) {
  return (
    error &&
    TLS_CERTIFICATE_ERRORS.has(
      error.code
    )
  );
}

function classifyError(
  error
) {
  if (!error) {
    return "internal_error";
  }

  if (
    error.code ===
    "PARSE_ERROR"
  ) {
    return "parse_error";
  }

  if (
    isTlsCertificateError(
      error
    )
  ) {
    return "tls_error";
  }

  if (
    error.code ===
    "HTTP_STATUS"
  ) {
    const status =
      Number(
        error.status || 0
      );

    if (
      status >= 500 &&
      status <= 599
    ) {
      return (
        "octowow_unreachable"
      );
    }

    if (
      status === 403 ||
      status === 429
    ) {
      return (
        "upstream_blocked"
      );
    }

    return (
      "upstream_http_error"
    );
  }

  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
    ].includes(
      error.code
    )
  ) {
    return (
      "octowow_unreachable"
    );
  }

  if (
    error.code ===
      "TOO_MANY_REDIRECTS" ||
    error.code ===
      "UNEXPECTED_REDIRECT_HOST" ||
    error.code ===
      "BODY_TOO_LARGE"
  ) {
    return (
      "upstream_http_error"
    );
  }

  return "internal_error";
}

async function fetchOneAttempt() {
  let upstream;
  let tlsMode =
    "strict";

  try {
    upstream =
      await requestPage({
        rejectUnauthorized:
          true,
      });
  } catch (error) {
    if (
      !isTlsCertificateError(
        error
      )
    ) {
      throw error;
    }

    /*
      OctoWoW has previously had
      certificate/name problems for
      automated clients.

      Only certificate validation
      errors trigger this fallback.
    */
    tlsMode =
      "fallback";

    try {
      upstream =
        await requestPage({
          rejectUnauthorized:
            false,
        });
    } catch (
      fallbackError
    ) {
      if (
        isTlsCertificateError(
          fallbackError
        )
      ) {
        throw makeError(
          fallbackError.message,
          fallbackError.code ||
            "TLS_ERROR"
        );
      }

      throw fallbackError;
    }
  }

  if (
    upstream.status < 200 ||
    upstream.status >= 300
  ) {
    throw makeError(
      `OctoWoW returned HTTP ${upstream.status}`,
      "HTTP_STATUS",
      {
        status:
          upstream.status,
      }
    );
  }

  const realms =
    parseRealms(
      upstream.body
    );

  return {
    realms,
    tlsMode,
  };
}

async function readStatusWithRetries() {
  const errors = [];

  for (
    let attempt = 0;
    attempt <
    RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const delay =
      RETRY_DELAYS_MS[
        attempt
      ];

    if (delay > 0) {
      await sleep(
        delay
      );
    }

    try {
      const result =
        await fetchOneAttempt();

      return {
        ...result,

        attemptsUsed:
          attempt + 1,
      };
    } catch (error) {
      const kind =
        classifyError(error);

      errors.push({
        attempt:
          attempt + 1,

        kind,

        status:
          error.status ||
          null,

        message:
          error.message,
      });

      /*
        A parser failure means we DID
        reach the website successfully,
        but its structure no longer
        matches what we trust.

        Repeating the request is not
        useful and could create false
        realm information.
      */
      if (
        kind ===
        "parse_error"
      ) {
        throw makeError(
          error.message,
          "FINAL_ERROR",
          {
            kind,
            errors,
          }
        );
      }
    }
  }

  /*
    Pick the most useful final
    classification.

    If every attempt indicates the
    OctoWoW service is unreachable,
    classify it as a real connectivity
    problem.

    Otherwise treat it as a monitor/
    upstream problem instead of falsely
    declaring the game offline.
  */
  const allUnreachable =
    errors.length > 0 &&
    errors.every(
      (item) =>
        item.kind ===
        "octowow_unreachable"
    );

  const kind =
    allUnreachable
      ? "octowow_unreachable"
      : errors[
          errors.length - 1
        ]?.kind ||
        "internal_error";

  throw makeError(
    "All OctoWoW probe attempts failed",
    "FINAL_ERROR",
    {
      kind,
      errors,
    }
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

  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  if (
    request.method !== "GET"
  ) {
    return response
      .status(405)
      .json({
        ok: false,
        error:
          "Method not allowed",
      });
  }

  if (
    !isAuthorized(request)
  ) {
    return response
      .status(401)
      .json({
        ok: false,
        error:
          "Unauthorized",
      });
  }

  try {
    const result =
      await readStatusWithRetries();

    return response
      .status(200)
      .json({
        ok: true,

        source:
          "OctoWoW Realm Status",

        checkedAt:
          new Date().toISOString(),

        attemptsUsed:
          result.attemptsUsed,

        tlsMode:
          result.tlsMode,

        realms:
          result.realms,
      });
  } catch (error) {
    const kind =
      error.kind ||
      classifyError(
        error
      );

    const status =
      kind ===
      "octowow_unreachable"
        ? 503
        : 502;

    return response
      .status(status)
      .json({
        ok: false,

        kind,

        checkedAt:
          new Date().toISOString(),

        error:
          error.message,

        attempts:
          Array.isArray(
            error.errors
          )
            ? error.errors
            : [],
      });
  }
}
