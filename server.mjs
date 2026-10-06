import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import httpProxy from "http-proxy";

const PORT = Number(process.env.PORT || 80);
const DISPLAY = ":99";
const CHROME = "/usr/bin/chromium";

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function start(command, args, env = {}) {
  const p = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  p.stdout.on("data", d => console.log(`[${command}] ${d}`));
  p.stderr.on("data", d => console.log(`[${command}] ${d}`));
  p.on("error", e => console.error(`[${command}] ${e.message}`));

  return p;
}

start("Xvfb", [
  DISPLAY,
  "-screen", "0", "1366x768x24",
  "-ac",
  "-nolisten", "tcp"
]);

start("x11vnc", [
  "-display", DISPLAY,
  "-rfbport", "5900",
  "-localhost",
  "-forever",
  "-shared",
  "-nopw",
  "-noxdamage",
  "-quiet"
]);

start("python3", [
  "-m", "http.server",
  "6080",
  "--bind", "127.0.0.1",
  "--directory", "/usr/share/novnc"
]);

start("websockify", [
  "127.0.0.1:6081",
  "127.0.0.1:5900"
]);

let browser;
let context;
let page;
let queue = Promise.resolve();

async function ensureBrowser() {
  if (browser?.isConnected() && page && !page.isClosed()) {
    return page;
  }

  const { chromium } = await import("playwright-core");

  browser = await chromium.launch({
    executablePath: CHROME,
    headless: false,
    env: {
      ...process.env,
      DISPLAY
    },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--window-size=1366,768",
      "--start-maximized"
    ]
  });

  context = await browser.newContext({
    viewport: {
      width: 1366,
      height: 768
    }
  });

  page = await context.newPage();
  await page.goto("about:blank");

  return page;
}

function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function executeAction(p, body) {
  const action = body?.action;
  const timeout = Number(body?.timeout || 15000);

  switch (action) {
    case "navigate": {
      const url = String(body?.url || "");

      if (!/^https?:\/\//i.test(url)) {
        throw new Error("url must be http/https");
      }

      await p.goto(url, {
        waitUntil: body.waitUntil || "domcontentloaded",
        timeout
      });

      return {
        action,
        url: p.url(),
        title: await p.title()
      };
    }

    case "click":
      await p
        .locator(String(body.selector))
        .first()
        .click({ timeout });

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "fill":
      await p
        .locator(String(body.selector))
        .first()
        .fill(String(body.text ?? ""), { timeout });

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "select":
      await p
        .locator(String(body.selector))
        .first()
        .selectOption(body.value, { timeout });

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "press":
      if (body.selector) {
        await p
          .locator(String(body.selector))
          .first()
          .press(String(body.key || "Enter"), { timeout });
      } else {
        await p.keyboard.press(String(body.key || "Enter"));
      }

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "back":
      await p
        .goBack({
          waitUntil: "domcontentloaded",
          timeout
        })
        .catch(() => {});

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "forward":
      await p
        .goForward({
          waitUntil: "domcontentloaded",
          timeout
        })
        .catch(() => {});

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "wait":
      if (body.selector) {
        await p
          .locator(String(body.selector))
          .first()
          .waitFor({
            state: body.state || "visible",
            timeout
          });
      } else {
        await p.waitForTimeout(Number(body.ms || 1000));
      }

      return {
        action,
        url: p.url(),
        title: await p.title()
      };

    case "content": {
      const text = await p
        .locator("body")
        .innerText({ timeout });

      return {
        action,
        url: p.url(),
        title: await p.title(),
        text: text.slice(0, 200000)
      };
    }

    case "screenshot": {
      const image = await p.screenshot({
        type: "png",
        fullPage: Boolean(body.fullPage)
      });

      return {
        action,
        url: p.url(),
        title: await p.title(),
        image: image.toString("base64")
      };
    }

    default:
      throw new Error(
        "unknown action: " + String(action)
      );
  }
}

const vncProxy = httpProxy.createProxyServer({
  target: "http://127.0.0.1:6080",
  changeOrigin: true
});

vncProxy.on("error", (_err, _req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, {
      "content-type": "text/plain"
    });

    res.end("noVNC unavailable");
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(
      req.url || "/",
      "http://localhost"
    );

    if (
      req.method === "GET" &&
      u.pathname === "/api/health"
    ) {
      const version = spawnSync(
        CHROME,
        ["--version"],
        {
          encoding: "utf8",
          timeout: 10000
        }
      );

      return json(res, 200, {
        ok: true,
        service: "nexus-chromium-executor",
        browser: "chromium",
        mode: "visible",
        executablePath: CHROME,
        chromiumVersion:
          (version.stdout || version.stderr || "").trim(),
        chromiumBinaryOk: version.status === 0,
        vnc: true,
        batchActions: true,
        actions: [
          "navigate",
          "click",
          "fill",
          "select",
          "press",
          "back",
          "forward",
          "wait",
          "content",
          "screenshot"
        ]
      });
    }

    if (
      (req.method === "GET" || req.method === "POST") &&
      u.pathname === "/api/browser"
    ) {
      let target = u.searchParams.get("url") || "";

      if (req.method === "POST") {
        const body = await readBody(req);

        target =
          typeof body?.url === "string"
            ? body.url.trim()
            : "";
      }

      if (!/^https?:\/\//i.test(target)) {
        return json(res, 400, {
          ok: false,
          error: "url must be http/https"
        });
      }

      const result = await serial(async () => {
        const p = await ensureBrowser();

        await p.goto(target, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        return {
          url: p.url(),
          title: await p.title()
        };
      });

      return json(res, 200, {
        ok: true,
        result
      });
    }

    if (
      req.method === "POST" &&
      u.pathname === "/api/browser/actions"
    ) {
      const body = await readBody(req);
      const actions = Array.isArray(body?.actions)
        ? body.actions
        : [];

      if (!actions.length) {
        return json(res, 400, {
          ok: false,
          error: "actions must be a non-empty array"
        });
      }

      const result = await serial(async () => {
        const p = await ensureBrowser();
        const results = [];

        for (const step of actions) {
          results.push(
            await executeAction(p, step)
          );
        }

        return {
          url: p.url(),
          title: await p.title(),
          results
        };
      });

      return json(res, 200, {
        ok: true,
        action: "batch",
        result
      });
    }

    if (
      req.method === "POST" &&
      u.pathname === "/api/browser/action"
    ) {
      const body = await readBody(req);

      const result = await serial(async () => {
        const p = await ensureBrowser();

        return await executeAction(
          p,
          body
        );
      });

      return json(res, 200, {
        ok: true,
        action: body?.action,
        result
      });
    }

    if (
      req.method === "GET" &&
      u.pathname === "/api/browser/state"
    ) {
      const p = await ensureBrowser();

      return json(res, 200, {
        ok: true,
        url: p.url(),
        title: await p.title(),
        closed: p.isClosed()
      });
    }

    if (
      req.method === "GET" &&
      u.pathname === "/"
    ) {
      const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Chromium Executor</title>
<style>
html,body{
  margin:0;
  width:100%;
  height:100%;
  background:#111;
}
iframe{
  width:100%;
  height:100%;
  border:0;
}
</style>
</head>
<body>
<iframe src="/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=websockify"></iframe>
</body>
</html>`;

      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8"
      });

      return res.end(html);
    }

    return vncProxy.web(req, res);

  } catch (error) {
    console.error("Request error:", error);

    return json(res, 500, {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

server.on("upgrade", (req, socket, head) => {
  const wsProxy = httpProxy.createProxyServer({
    target: "ws://127.0.0.1:6081",
    ws: true
  });

  wsProxy.on("error", () => socket.destroy());

  wsProxy.ws(
    req,
    socket,
    head
  );
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Visible Chromium executor on ${PORT}`
    );
  }
);

ensureBrowser().catch(error => {
  console.error(
    "Chromium startup:",
    error
  );
});
