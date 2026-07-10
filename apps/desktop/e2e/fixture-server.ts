import { createServer, type Server } from "node:http";

export async function startCursorSyncFixtureServer(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
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
