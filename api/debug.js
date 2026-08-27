import http from "node:http";
import https from "node:https";

function requestPage(
  protocol = "https:",
  hostname = "octowow.st",
  path = "/",
  redirects = 0
) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    const client =
      protocol === "https:" ? https : http;

    const options = {
      protocol,
      hostname,
      port: protocol === "https:" ? 443 : 80,
      path,
      method: "GET",

      headers: {
        // Используем обычный браузерный User-Agent,
        // чтобы проверить, не отдаёт ли OctoWoW
        // отдельную страницу ботам.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/151.0.0.0 Safari/537.36",

        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

        "Accept-Language":
          "en-US,en;q=0.9",

        "Accept-Encoding":
          "identity",

        "Cache-Control":
          "no-cache",

        Pragma:
          "no-cache",
      },

      timeout: 15000,
    };

    if (protocol === "https:") {
      // Только публичная главная OctoWoW.
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

          const current =
            `${protocol}//${hostname}${path}`;

          const next = new URL(
            res.headers.location,
            current
          );

          resolve(
            requestPage(
              next.protocol,
              next.hostname,
              next.pathname + next.search,
              redirects + 1
            )
          );

          return;
        }

        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          resolve({
            status,
            hostname,
            path,
            contentType:
              res.headers["content-type"] || null,
            server:
              res.headers["server"] || null,
            body:
              Buffer.concat(chunks).toString(
                "utf8"
              ),
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
    .replace(/&nbsp;|&#160;/gi, " ")
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

export default async function handler(
  request,
  response
) {
  response.setHeader(
    "Cache-Control",
    "no-store"
  );

  try {
    const upstream =
      await requestPage();

    const text =
      htmlToText(upstream.body);

    return response.status(200).json({
      ok: true,

      upstreamStatus:
        upstream.status,

      finalHost:
        upstream.hostname,

      finalPath:
        upstream.path,

      contentType:
        upstream.contentType,

      server:
        upstream.server,

      htmlLength:
        upstream.body.length,

      textLength:
        text.length,

      checks: {
        hasCThun:
          /C.?Thun/i.test(text),

        hasNZoth:
          /N.?Zoth/i.test(text),

        hasYShaarj:
          /Y.?Shaarj/i.test(text),

        hasHardcore:
          /Hardcore/i.test(text),

        hasNormal:
          /Normal/i.test(text),

        hasOnline:
          /\bOnline\b/i.test(text),

        hasOffline:
          /\bOffline\b/i.test(text),

        cloudflare:
          /cloudflare/i.test(text),

        challenge:
          /challenge|verify you are human|checking your browser|just a moment/i.test(
            text
          ),
      },

      // Только начало публичного текста страницы.
      // Никаких ключей/паролей здесь нет.
      preview:
        text.slice(0, 3000),
    });
  } catch (error) {
    return response.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
