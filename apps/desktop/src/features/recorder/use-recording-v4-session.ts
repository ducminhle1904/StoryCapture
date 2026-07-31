import type { StartRecordingV4Args } from "@storycapture/shared-types";
import type {
  RecordingV4Command,
  RecordingV4Event,
  RecordingV4Result,
} from "@storycapture/shared-types/recording-v4";
import { useCallback, useEffect, useRef } from "react";

import {
  commandRecordingV4,
  createRecordingV4,
  forgetRecordingV4Session,
  recalledRecordingV4Session,
  recordRecordingV4Action,
  rememberRecordingV4Session,
  subscribeRecordingV4,
  type RecordingV4ActionIntent,
  type RecordingV4ChannelHandle,
} from "@/ipc/recording-v4";

export interface RecordingV4SessionCallbacks {
  onEvent: (event: RecordingV4Event) => void;
  onReattached?: (sessionId: string) => void;
  onDetached?: (sessionId: string) => void;
  onReattachError?: (error: unknown) => void;
}

export function useRecordingV4Session(
  projectPath: string,
  callbacks: RecordingV4SessionCallbacks,
) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const sessionIdRef = useRef<string | null>(null);
  const channelRef = useRef<RecordingV4ChannelHandle | null>(null);

  const detach = useCallback(() => {
    if (channelRef.current) channelRef.current.onmessage = null;
    channelRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId) callbacksRef.current.onDetached?.(sessionId);
  }, []);

  const deliver = useCallback((event: RecordingV4Event) => {
    callbacksRef.current.onEvent(event);
    if (event.type === "terminal") {
      forgetRecordingV4Session(projectPath, event.result.session_id);
    } else if (event.type === "snapshot" && event.snapshot.terminal_result) {
      forgetRecordingV4Session(projectPath, event.snapshot.session_id);
    }
  }, [projectPath]);

  useEffect(() => {
    let active = true;
    const session = recalledRecordingV4Session(projectPath);
    if (session) {
      sessionIdRef.current = session.id;
      callbacksRef.current.onReattached?.(session.id);
      subscribeRecordingV4(session, deliver)
        .then((subscription) => {
          if (!active) {
            subscription.channel.onmessage = null;
            return;
          }
          channelRef.current = subscription.channel;
          if (subscription.snapshot) deliver({ type: "snapshot", snapshot: subscription.snapshot });
        })
        .catch((error) => {
          if (!active) return;
          callbacksRef.current.onReattachError?.(error);
        });
    }
    return () => {
      active = false;
      detach();
    };
  }, [deliver, detach, projectPath]);

  const start = useCallback(async (args: StartRecordingV4Args): Promise<string | null> => {
    if (sessionIdRef.current) throw new Error("A Recording V4 session is already attached.");
    const created = await createRecordingV4(args, deliver);
    sessionIdRef.current = created.session.id;
    channelRef.current = created.channel;
    rememberRecordingV4Session(projectPath, created.session.id);
    callbacksRef.current.onReattached?.(created.session.id);
    const result = await commandRecordingV4(created.session, "start");
    if (result) {
      deliver({ type: "terminal", result });
      return null;
    }
    return created.session.id;
  }, [deliver, projectPath]);

  const command = useCallback(async (value: RecordingV4Command): Promise<RecordingV4Result | null> => {
    const id = sessionIdRef.current;
    if (!id) return null;
    const result = await commandRecordingV4({ id }, value);
    if (result) {
      forgetRecordingV4Session(projectPath, id);
      deliver({ type: "terminal", result });
    }
    return result;
  }, [deliver, projectPath]);

  const recordAction = useCallback((action: RecordingV4ActionIntent): Promise<void> => {
    const id = sessionIdRef.current;
    return id ? recordRecordingV4Action({ id }, action) : Promise.resolve();
  }, []);

  const releaseTerminal = useCallback((sessionId: string) => {
    if (sessionIdRef.current !== sessionId) return;
    detach();
    sessionIdRef.current = null;
    forgetRecordingV4Session(projectPath, sessionId);
  }, [detach, projectPath]);

  return { start, command, recordAction, releaseTerminal, sessionIdRef };
}
