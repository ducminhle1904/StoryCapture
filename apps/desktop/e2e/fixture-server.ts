import { createServer, type RequestListener } from "node:http";

interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

async function startFixtureServer(handler: RequestListener): Promise<FixtureServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function startCursorSyncFixtureServer(): Promise<FixtureServer> {
  return startFixtureServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html><body style="margin:0;background:#101418;color:white;font-family:sans-serif">
  <button id="target" style="position:absolute;left:120px;top:140px;width:160px;height:52px">Commit action</button>
  <div id="paint-marker" data-sequence="0" style="position:absolute;left:24px;top:24px;width:24px;height:24px;background:#ff315f"></div>
  <script>
    const target = document.querySelector('#target');
    const marker = document.querySelector('#paint-marker');
    target.addEventListener('click', () => requestAnimationFrame(() => {
      const sequence = Number(marker.dataset.sequence) + 1;
      marker.dataset.sequence = String(sequence);
      marker.style.transform = 'translateX(' + sequence * 32 + 'px)';
      document.title = 'paint-' + sequence;
    }));
    setTimeout(() => { target.style.left = '180px'; }, 120);
  </script>
</body></html>`);
  });
}

export async function startSmoothScrollFixtureServer(): Promise<FixtureServer> {
  return startFixtureServer((_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html><body style="margin:0;min-height:2400px;background:#101418;color:white;font-family:sans-serif">
  <div style="position:sticky;top:0;height:64px;background:#202830;z-index:10">Sticky header</div>
  <button data-testid="picker-a" style="position:absolute;left:120px;top:100px;width:180px;height:52px">Picker A</button>
  <button data-testid="picker-b" style="position:absolute;left:120px;top:700px;width:180px;height:52px">Picker B</button>
  <div style="height:1300px"></div>
  <button data-testid="below-fold" style="margin-left:120px;width:180px;height:52px">Below fold</button>
  <div data-testid="panel" style="margin:120px;width:420px;height:240px;overflow:auto;border:1px solid white">
    <div style="height:900px;padding-top:760px">
      <button data-testid="nested-target" style="width:180px;height:52px">Nested target</button>
    </div>
  </div>
  <script>
    for (const id of ['below-fold', 'nested-target']) {
      document.querySelector('[data-testid="' + id + '"]').addEventListener('click', () => {
        document.body.dataset.clicked = id;
      });
    }
  </script>
</body></html>`);
  });
}
