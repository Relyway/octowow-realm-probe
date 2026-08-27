import http from "node:http";
import https from "node:https";

const REALMS = [
  {
    key: "cthun",
    label: "C'Thun (Hardcore)",
  },
  {
    key: "nzoth",
    label: "N'Zoth (Normal)",
  },
  {
    key: "yshaarj",
    label: "Y'Shaarj (PvP)",
  },
];

function requestPage(
  protocol = "https:",
  hostname = "octowow.st",
  path = "/",
  redirects = 0
) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) {
      reject(new Error("Too many redirects"));
      return;
    }

    const client = protocol === "https:" ? https : http;

    const options = {
      protocol,
      hostname,
      port: protocol === "https:" ? 443 : 80,
      path,
      method: "GET",

      headers: {
        "User-Agent":
          "OrderOfTheLion-OctoWoW-RealmProbe/1.0",
        Accept:
          "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },

      timeout: 15000,
    };

    if (protocol === "https:") {
      options.rejectUnauthorized = false;
    }

    const req = client.request(options, (res) => {
      const status = res.statusCode || 0;

      if (
        [301, 302, 303, 307, 308].includes(status) &&
        res.headers.location
      ) {
        res.resume();

        try {
          const currentUrl =
            protocol + "//" + hostname + path;

          const nextUrl = new URL(
            res.headers.location,
            currentUrl
          );

          resolve(
            requestPage(
              nextUrl.protocol,
              nextUrl.hostname,
              nextUrl.pathname + nextUrl.search,
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
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(
        new Error("OctoWoW request timed out")
      );
    });

    req.on("error", reject);

    req.end();
  });
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(
      /&#039;|&#39;|&apos;|&rsquo;|&#8217;/gi,
      "'"
    )
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRealms(html) {
  const text = htmlToText(html);

  const result = {};

  for (const realm of REALMS) {
    const position = text
      .toLowerCase()
      .indexOf(realm.label.toLowerCase());

    if (position === -1) {
      throw new Error(
        `Realm label not found: ${realm.label}`
      );
    }

    const nearby = text.slice(
      position,
      position + 250
    );

    const match = nearby.match(
      /\b(Online|Offline)\b/i
    );

    if (!match) {
      throw new Error(
        `Realm status not found: ${realm.label}`
      );
    }

    result[realm.key] =
      match[1].toLowerCase() === "online"
        ? "Online"
        : "Offline";
  }

  return result;
}

export default async function handler(request, response) {
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

  try {
    const upstream = await requestPage();

    if (
      upstream.status < 200 ||
      upstream.status >= 300
    ) {
      return response.status(502).json({
        ok: false,
        error: "OctoWoW upstream error",
        upstreamStatus: upstream.status,
      });
    }

    const realms = parseRealms(upstream.body);

    return response.status(200).json({
      ok: true,
      source: "OctoWoW Realm Status",
      checkedAt: new Date().toISOString(),
      realms,
    });
  } catch (error) {
    return response.status(502).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
