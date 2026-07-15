import { createServer, type RequestListener } from "node:http";

interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

interface RecordEngineAudioFixtureServer extends FixtureServer {
  crossOriginUrl: string;
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
  <button id="target" data-testid="target" style="position:absolute;left:120px;top:140px;width:160px;height:52px">Commit action</button>
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

function recordEngineAudioFrameHtml(frameId: string, frequency: number): string {
  return `<!doctype html>
<html><body style="margin:0;background:#182029;color:white;font-family:sans-serif">
  <p>Audio frame ${frameId}</p>
  <script>
    let context;
    let oscillator;
    let gain;
    async function startAudio() {
      if (!context) {
        context = new AudioContext();
        oscillator = new OscillatorNode(context, { frequency: ${frequency} });
        gain = new GainNode(context, { gain: 0.04 });
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
      }
      await context.resume();
      parent.postMessage({ type: "fixture-audio-ready", frameId: ${JSON.stringify(frameId)} }, "*");
    }
    addEventListener("message", (event) => {
      if (event.data?.type === "fixture-audio-start") void startAudio();
      if (event.data?.type === "fixture-audio-muted" && gain) {
        gain.gain.setValueAtTime(event.data.muted ? 0 : 0.04, context.currentTime);
      }
    });
  </script>
</body></html>`;
}

export async function startRecordEngineAudioFixtureServer(): Promise<RecordEngineAudioFixtureServer> {
  const crossOrigin = await startFixtureServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(recordEngineAudioFrameHtml("cross-origin", 660));
  });

  try {
    const primary = await startFixtureServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
      if (pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === "/frame-same") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(recordEngineAudioFrameHtml("same-origin", 520));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html><body style="margin:0;background:#101418;color:white;font-family:sans-serif">
  <h1>Author preview audio fixture: ${pathname === "/next" ? "navigated" : "initial"}</h1>
  <iframe title="same-origin audio" src="/frame-same"></iframe>
  <iframe title="cross-origin audio" src="${crossOrigin.url}/frame-cross"></iframe>
  <script>
    const audioFrames = () => Array.from(document.querySelectorAll("iframe"));
    window.__startFixtureFramesAudio = () => new Promise((resolve, reject) => {
      const ready = new Set();
      const sendStart = () => audioFrames().forEach((frame) =>
        frame.contentWindow?.postMessage({ type: "fixture-audio-start" }, "*"),
      );
      const onMessage = (event) => {
        if (event.data?.type !== "fixture-audio-ready") return;
        ready.add(event.data.frameId);
        if (ready.size !== 2) return;
        clearInterval(retry);
        clearTimeout(timeout);
        removeEventListener("message", onMessage);
        resolve(Array.from(ready).sort());
      };
      addEventListener("message", onMessage);
      const retry = setInterval(sendStart, 50);
      const timeout = setTimeout(() => {
        clearInterval(retry);
        removeEventListener("message", onMessage);
        reject(new Error("audio frames did not start"));
      }, 2_000);
      sendStart();
    });
    window.__setFixtureFramesMuted = (muted) => audioFrames().forEach((frame) =>
      frame.contentWindow?.postMessage({ type: "fixture-audio-muted", muted }, "*"),
    );
  </script>
</body></html>`);
    });
    return {
      url: primary.url,
      crossOriginUrl: crossOrigin.url,
      close: async () => {
        await Promise.all([primary.close(), crossOrigin.close()]);
      },
    };
  } catch (error) {
    await crossOrigin.close();
    throw error;
  }
}

export async function startRecordEngineRepairFixtureServer(): Promise<FixtureServer> {
  let pageLoads = 0;
  let stepRepairArmed = false;
  let unsafeSceneLoads = 0;
  return startFixtureServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, pageLoads, unsafeSceneLoads }));
      return;
    }
    if (pathname === "/initial") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body><h1>Stable initial page</h1></body></html>");
      return;
    }
    if (pathname === "/arm-step-repair") {
      stepRepairArmed = true;
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === "/step-state") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ready: stepRepairArmed }));
      return;
    }
    if (pathname === "/step") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html><body style="margin:0;background:#101418;color:white;font-family:sans-serif">
  <h1>Live step-repair fixture</h1>
  <p id="repair-status">Target intentionally missing</p>
  <script>
    const poll = setInterval(async () => {
      const state = await fetch('/step-state', { cache: 'no-store' }).then((response) => response.json());
      if (!state.ready || document.querySelector('[data-testid="step-repair-target"]')) return;
      const button = document.createElement('button');
      button.dataset.testid = 'step-repair-target';
      button.textContent = 'Recovered step target';
      document.body.append(button);
      document.querySelector('#repair-status')?.remove();
      clearInterval(poll);
    }, 50);
  </script>
</body></html>`);
      return;
    }
    if (pathname === "/unsafe-scene") {
      unsafeSceneLoads += 1;
      const shouldLoseTarget = unsafeSceneLoads === 1;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html><body data-unsafe-scene-loads="${unsafeSceneLoads}" style="margin:0;background:#101418;color:white;font-family:sans-serif">
  <h1>Unsafe live scene-repair fixture</h1>
  <div data-testid="unsafe-source" style="position:absolute;left:40px;top:100px;width:80px;height:50px;background:#4678ff">Source</div>
  <div data-testid="unsafe-destination" style="position:absolute;left:220px;top:100px;width:80px;height:50px;background:#38a169">Destination</div>
  <script>
    if (${shouldLoseTarget ? "true" : "false"}) {
      document.querySelector('[data-testid="unsafe-source"]').addEventListener('mousedown', () => {
        document.querySelector('[data-testid="unsafe-destination"]')?.remove();
      }, { once: true });
    }
  </script>
</body></html>`);
      return;
    }
    if (pathname !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    pageLoads += 1;
    const repaired = pageLoads >= 2;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html><body data-page-loads="${pageLoads}" style="margin:0;background:#101418;color:white;font-family:sans-serif">
  <h1>Live repair fixture</h1>
  ${repaired ? '<button data-testid="repair-target">Recovered target</button>' : "<p>Target intentionally missing</p>"}
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

export async function startRecordEngineInteractionFixtureServer(): Promise<FixtureServer> {
  return startFixtureServer((_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html><body style="margin:0;background:#101418;color:white;font-family:sans-serif">
  <button data-testid="drag-source" style="position:absolute;left:120px;top:140px;width:160px;height:52px">Drag source</button>
  <div data-testid="drag-destination" style="position:absolute;left:520px;top:140px;width:220px;height:160px;border:2px solid #39ff88">Drop destination</div>
  <label style="position:absolute;left:120px;top:360px">
    Visible upload
    <input data-testid="visible-upload" type="file" accept=".txt">
  </label>
  <input data-testid="hidden-upload" type="file" accept=".txt" style="display:none">
  <script>
    const body = document.body;
    const source = document.querySelector('[data-testid="drag-source"]');
    const destination = document.querySelector('[data-testid="drag-destination"]');
    let dragging = false;
    source.addEventListener('mousedown', () => {
      dragging = true;
      body.dataset.dragDown = String(Number(body.dataset.dragDown || 0) + 1);
    });
    document.addEventListener('mousemove', () => {
      if (dragging) body.dataset.dragMove = String(Number(body.dataset.dragMove || 0) + 1);
    });
    document.addEventListener('mouseup', (event) => {
      if (!dragging) return;
      dragging = false;
      body.dataset.dragUp = String(Number(body.dataset.dragUp || 0) + 1);
      const atPoint = document.elementFromPoint(event.clientX, event.clientY);
      if (atPoint === destination || atPoint?.closest('[data-testid="drag-destination"]')) {
        destination.append(source);
        source.style.position = 'static';
        body.dataset.dragged = 'true';
      }
    });
    for (const name of ['visible-upload', 'hidden-upload']) {
      document.querySelector('[data-testid="' + name + '"]').addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        body.dataset[name === 'visible-upload' ? 'visibleUpload' : 'hiddenUpload'] =
          file ? file.name + ':' + file.size : 'missing';
      });
    }
  </script>
</body></html>`);
  });
}
