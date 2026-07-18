import { describe, expect, it } from "vitest";
import { TauriChannelSequencer } from "./channel-sequence";

describe("TauriChannelSequencer", () => {
  it("starts callback ids at zero for each renderer instance", () => {
    const firstRenderer = new TauriChannelSequencer();
    expect(firstRenderer.message(1, "first")).toEqual({ index: 0, message: "first" });
    expect(firstRenderer.message(1, "second")).toEqual({ index: 1, message: "second" });

    const reloadedRenderer = new TauriChannelSequencer();
    expect(reloadedRenderer.message(1, "after reload")).toEqual({
      index: 0,
      message: "after reload",
    });
  });

  it("sequences interleaved channels independently", () => {
    const sequencer = new TauriChannelSequencer();

    expect(sequencer.message(7, "a").index).toBe(0);
    expect(sequencer.message(8, "b").index).toBe(0);
    expect(sequencer.message(7, "c").index).toBe(1);
    expect(sequencer.message(8, "d").index).toBe(1);
  });

  it("cleans sequence state on channel end and unregister", () => {
    const sequencer = new TauriChannelSequencer();

    sequencer.message(4, "before end");
    expect(sequencer.end(4)).toEqual({ index: 1, end: true });
    expect(sequencer.message(4, "after end").index).toBe(0);

    sequencer.message(5, "before unregister");
    sequencer.forget(5);
    expect(sequencer.message(5, "after unregister").index).toBe(0);
  });
});
