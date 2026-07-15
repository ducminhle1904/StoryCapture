import { randomUUID } from "node:crypto";
import {
  type CaptureBackend,
  type CaptureBackendCapabilities,
  type CaptureBackendProbe,
  type CaptureBackendProvenance,
  CaptureBackendRegistry,
  type CaptureBackendRequest,
  type CaptureBackendResult,
  type CaptureBackendSession,
  type CaptureBackendSink,
  createCaptureBackendRequest,
  resolveCaptureBackend,
} from "./capture-backend";
import type { CaptureTarget } from "./legacy/shared";

export interface ElectronCaptureBackendDelegate {
  start(request: CaptureBackendRequest, sink: CaptureBackendSink): Promise<string>;
  pause(delegateSessionId: string): Promise<void>;
  resume(delegateSessionId: string): Promise<void>;
  stop(delegateSessionId: string): Promise<Omit<CaptureBackendResult, "backend_id" | "session_id">>;
  abort(delegateSessionId: string, reason: string): Promise<void>;
}

interface OwnedSession {
  publicSession: CaptureBackendSession;
  delegateSessionId: string;
  terminal: Promise<CaptureBackendResult> | null;
  aborted: boolean;
}

export class ElectronCaptureBackend implements CaptureBackend {
  readonly id: "electron_author_preview" | "electron_external";
  readonly #delegate: ElectronCaptureBackendDelegate;
  readonly #sessions = new Map<string, OwnedSession>();

  constructor(
    id: "electron_author_preview" | "electron_external",
    delegate: ElectronCaptureBackendDelegate,
  ) {
    this.id = id;
    this.#delegate = delegate;
  }

  capabilities(): CaptureBackendCapabilities {
    return {
      contract_version: 1,
      backend_id: this.id,
      target_classes:
        this.id === "electron_author_preview"
          ? ["browser_surface"]
          : ["external_window", "display"],
      delivery_modes: ["host_frames"],
      pixel_formats: ["bgra"],
      timestamp_source: "recording_media_clock",
      cursor_control: this.id === "electron_external" ? "selectable" : "fixed_excluded",
      supports_pause: true,
      supports_dynamic_resize: false,
      native: false,
    };
  }

  async probe(request: CaptureBackendRequest): Promise<CaptureBackendProbe> {
    const supported = this.capabilities().target_classes.includes(request.target_class);
    return {
      supported,
      reason: supported ? null : "capability_mismatch",
      delivery_mode: supported ? "host_frames" : null,
      platform_version: process.platform,
    };
  }

  async start(
    request: CaptureBackendRequest,
    sink: CaptureBackendSink,
  ): Promise<CaptureBackendSession> {
    const probe = await this.probe(request);
    if (!probe.supported) throw new Error(`${this.id} does not support ${request.target_class}`);
    const publicSession: CaptureBackendSession = {
      backend_id: this.id,
      session_id: randomUUID(),
      ownership_token: randomUUID(),
    };
    const delegateSessionId = await this.#delegate.start(request, sink);
    this.#sessions.set(publicSession.session_id, {
      publicSession,
      delegateSessionId,
      terminal: null,
      aborted: false,
    });
    return publicSession;
  }

  pause(session: CaptureBackendSession): Promise<void> {
    const owned = this.#active(session);
    return this.#delegate.pause(owned.delegateSessionId);
  }

  resume(session: CaptureBackendSession): Promise<void> {
    const owned = this.#active(session);
    return this.#delegate.resume(owned.delegateSessionId);
  }

  stop(session: CaptureBackendSession): Promise<CaptureBackendResult> {
    const owned = this.#owned(session);
    owned.terminal ??= this.#delegate.stop(owned.delegateSessionId).then((result) => ({
      ...result,
      backend_id: this.id,
      session_id: session.session_id,
    }));
    return owned.terminal;
  }

  async abort(session: CaptureBackendSession, reason: string): Promise<void> {
    const owned = this.#owned(session);
    if (owned.aborted || owned.terminal) return;
    owned.aborted = true;
    owned.terminal = this.#delegate.abort(owned.delegateSessionId, reason).then(() => ({
      backend_id: this.id,
      session_id: session.session_id,
      terminal_status: "aborted",
      target_loss_reason: null,
      last_pts_us: null,
    }));
    await owned.terminal;
  }

  #active(session: CaptureBackendSession): OwnedSession {
    const owned = this.#owned(session);
    if (owned.terminal || owned.aborted) throw new Error("capture backend session is terminal");
    return owned;
  }

  #owned(session: CaptureBackendSession): OwnedSession {
    const owned = this.#sessions.get(session.session_id);
    if (
      !owned ||
      owned.publicSession.backend_id !== session.backend_id ||
      owned.publicSession.ownership_token !== session.ownership_token
    ) {
      throw new Error("capture backend session ownership mismatch");
    }
    return owned;
  }
}

function probeOnlyDelegate(): ElectronCaptureBackendDelegate {
  const unsupported = async (): Promise<never> => {
    throw new Error("probe-only Electron backend cannot start");
  };
  return {
    start: unsupported,
    pause: unsupported,
    resume: unsupported,
    stop: unsupported,
    abort: unsupported,
  };
}

export async function electronCaptureProvenance(input: {
  target: CaptureTarget;
  width: number;
  height: number;
  fps: number;
  includeCursor: boolean;
}): Promise<CaptureBackendProvenance> {
  const registry = new CaptureBackendRegistry();
  const delegate = probeOnlyDelegate();
  registry.register(new ElectronCaptureBackend("electron_author_preview", delegate));
  registry.register(new ElectronCaptureBackend("electron_external", delegate));
  const resolved = await resolveCaptureBackend({
    registry,
    request: createCaptureBackendRequest(input),
  });
  return resolved.provenance;
}
