import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADOBE_XMP_UUID,
  appendAiVoiceXmpToMp4,
  buildAdobeXmpUuidBox,
  buildAiVoiceXmpPacket,
  MAX_XMP_PACKET_BYTES,
  parseAiVoiceXmpPacket,
  readAdobeXmpMetadata,
} from "./export-xmp";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function minimalMp4Prefix(): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, 4, "ascii");
  box.write("isom", 8, 4, "ascii");
  box.writeUInt32BE(0x200, 12);
  box.write("isom", 16, 4, "ascii");
  box.write("mp42", 20, 4, "ascii");
  return box;
}

describe("export XMP", () => {
  it("builds a bounded Adobe UUID box with only approved AI voice fields", () => {
    const packet = buildAiVoiceXmpPacket();
    const xml = packet.toString("utf8");
    const box = buildAdobeXmpUuidBox(packet);

    expect(packet.length).toBeLessThanOrEqual(MAX_XMP_PACKET_BYTES);
    expect(box.readUInt32BE(0)).toBe(box.length);
    expect(box.toString("ascii", 4, 8)).toBe("uuid");
    expect(box.subarray(8, 24)).toEqual(ADOBE_XMP_UUID);
    expect(xml).toContain('xmp:CreatorTool="StoryCapture"');
    expect(xml).toContain('dc:format="video/mp4"');
    expect(xml).toContain('sc:ContainsAIGeneratedVoice="true"');
    expect(xml).toContain('sc:AIGenerationMethod="text-to-speech"');
    expect(xml).not.toMatch(/prompt|spoken|provider|credential|api[_-]?key/i);
    expect(parseAiVoiceXmpPacket(packet)).toEqual({
      creatorTool: "StoryCapture",
      format: "video/mp4",
      containsAiGeneratedVoice: true,
      generationMethod: "text-to-speech",
    });
  });

  it("rejects oversized packets and unapproved metadata fields", () => {
    expect(() => buildAdobeXmpUuidBox(Buffer.alloc(MAX_XMP_PACKET_BYTES + 1))).toThrow(/bytes/i);
    const withPrompt = Buffer.from(
      buildAiVoiceXmpPacket().toString("utf8").replace("/>", ' sc:Prompt="private prompt"/>'),
      "utf8",
    );
    expect(() => parseAiVoiceXmpPacket(withPrompt)).toThrow(/unapproved metadata fields/i);
  });

  it("appends one parseable top-level XMP box without changing existing bytes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-xmp-"));
    tempDirs.push(directory);
    const filePath = path.join(directory, "delivery.mp4");
    const prefix = minimalMp4Prefix();
    await fs.writeFile(filePath, prefix);

    await appendAiVoiceXmpToMp4(filePath);

    const marked = await fs.readFile(filePath);
    expect(marked.subarray(0, prefix.length)).toEqual(prefix);
    expect(marked.length - prefix.length).toBe(buildAdobeXmpUuidBox().length);
    await expect(readAdobeXmpMetadata(filePath)).resolves.toMatchObject({
      creatorTool: "StoryCapture",
      containsAiGeneratedVoice: true,
    });
    await expect(appendAiVoiceXmpToMp4(filePath)).rejects.toThrow(/already contains/i);
  });
});
