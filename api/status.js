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

const RETRY_DELAYS_MS = [
  0,
  1500,
  4000,
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requestPage(
  protocol = "https:",
  hostname = "octowow.st",
  path = "/",
  redirects = 0
) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(
        new Error("Too many redirects")
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

      timeout: 10000,
    };

    if (protocol === "https:") {
      options.rejectUnauthorized = false;
      options.servername = hostname;
    }

    const req = client.request(
      options,
      (res) => {
        const status =
          res.statusCode || 0;

        if (
          [301, 302, 303, 307, 308].includes(status) &&
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
              requestPage(
                next.protocol,
                next.hostname,
                next.pathname +
                  next.search,
                redirects + 1
              )
            );
          } catch (error) {
            reject(error);
          }

          return;
        }

        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          resolve({
            status,
            body:
              Buffer.concat(
                chunks
              ).toString("utf8"),
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(
        new Error(
          "OctoWoW request timed out"
        )
      );
    });

    req.on("error", reject);

    req.end();
  });
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
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&nbsp;|&#160;/gi,
      " "
    )
    .replace(/&amp;/gi, "&")
    .replace(
      /&#039;|&#39;|&apos;|&rsquo;|&#8217;/gi,
      "'"
    )
    .replace(/&quot;/gi, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
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
    (match =
      nameRegex.exec(text)) !==
    null
  ) {
    const nearby =
      text.slice(
        match.index,
        match.index + 250
      );

    const typeRegex =
      new RegExp(
        `\\b${realm.type}\\b`,
        "i"
      );

    if (
      !typeRegex.test(nearby)
    ) {
      continue;
    }

    const statusMatch =
      nearby.match(
        /\b(Online|Offline)\b/i
      );

    if (!statusMatch) {
      continue;
    }

    return statusMatch[1]
      .toLowerCase() ===
      "online"
      ? "Online"
      : "Offline";
  }

  throw new Error(
    `Could not determine status for ${realm.name} (${realm.type})`
  );
}

function parseRealms(html) {
  const text =
    htmlToText(html);

  const result = {};

  for (const realm of REALMS) {
    result[realm.key] =
      findRealmStatus(
        text,
        realm
      );
  }

  return result;
}

async function readRealmsWithRetries() {
  const errors = [];

  for (
    let attempt = 0;
    attempt <
    RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const delay =
      RETRY_DELAYS_MS[attempt];

    if (delay > 0) {
      await sleep(delay);
    }

    try {
      const upstream =
        await requestPage();

      if (
        upstream.status < 200 ||
        upstream.status >= 300
      ) {
        throw new Error(
          `OctoWoW HTTP ${upstream.status}`
        );
      }

      const realms =
        parseRealms(
          upstream.body
        );

      return {
        realms,
        attemptsUsed:
          attempt + 1,
      };
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  throw new Error(
    "All OctoWoW probe attempts failed: " +
      errors.join(" | ")
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

  try {
    const result =
      await readRealmsWithRetries();

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

        realms:
          result.realms,
      });
  } catch (error) {
    return response
      .status(502)
      .json({
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
  }
}
