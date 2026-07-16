import fs from "node:fs/promises";

export const ADOBE_XMP_UUID = Buffer.from("be7acfcb97a942e89c71999491e3afac", "hex");
export const MAX_XMP_PACKET_BYTES = 64 * 1024;

const XMP_CREATOR_TOOL = "StoryCapture";
const XMP_FORMAT = "video/mp4";
const XMP_AI_VOICE_VALUE = "true";
const XMP_GENERATION_METHOD = "text-to-speech";

const DESCRIPTION_ATTRIBUTE_VALUES = {
  "rdf:about": "",
  "xmlns:xmp": "http://ns.adobe.com/xap/1.0/",
  "xmlns:dc": "http://purl.org/dc/elements/1.1/",
  "xmlns:sc": "https://storycapture.app/ns/ai/1.0/",
  "xmp:CreatorTool": XMP_CREATOR_TOOL,
  "dc:format": XMP_FORMAT,
  "sc:ContainsAIGeneratedVoice": XMP_AI_VOICE_VALUE,
  "sc:AIGenerationMethod": XMP_GENERATION_METHOD,
} as const;

export interface AiVoiceXmpMetadata {
  creatorTool: "StoryCapture";
  format: "video/mp4";
  containsAiGeneratedVoice: true;
  generationMethod: "text-to-speech";
}

function assertBoundedPacket(packet: Buffer): void {
  if (packet.length === 0 || packet.length > MAX_XMP_PACKET_BYTES) {
    throw new Error(
      `XMP packet is ${packet.length} bytes; expected 1-${MAX_XMP_PACKET_BYTES} bytes.`,
    );
  }
}

export function buildAiVoiceXmpPacket(): Buffer {
  const xml =
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:sc="https://storycapture.app/ns/ai/1.0/" ' +
    'xmp:CreatorTool="StoryCapture" dc:format="video/mp4" ' +
    'sc:ContainsAIGeneratedVoice="true" sc:AIGenerationMethod="text-to-speech"/>' +
    "</rdf:RDF></x:xmpmeta>" +
    '<?xpacket end="w"?>';
  const packet = Buffer.from(xml, "utf8");
  assertBoundedPacket(packet);
  return packet;
}

export function buildAdobeXmpUuidBox(packet = buildAiVoiceXmpPacket()): Buffer {
  assertBoundedPacket(packet);
  const boxSize = 8 + ADOBE_XMP_UUID.length + packet.length;
  const box = Buffer.allocUnsafe(boxSize);
  box.writeUInt32BE(boxSize, 0);
  box.write("uuid", 4, 4, "ascii");
  ADOBE_XMP_UUID.copy(box, 8);
  packet.copy(box, 24);
  return box;
}

function parseDescriptionAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"<>&]*)"/g;
  let cursor = 0;
  for (const match of source.matchAll(attributePattern)) {
    if (match.index == null || source.slice(cursor, match.index).trim()) {
      throw new Error("XMP description contains malformed XML attributes.");
    }
    const name = match[1];
    const value = match[2];
    if (!name || value == null || attributes.has(name)) {
      throw new Error("XMP description contains duplicate or malformed attributes.");
    }
    attributes.set(name, value);
    cursor = match.index + match[0].length;
  }
  if (source.slice(cursor).trim()) {
    throw new Error("XMP description contains malformed XML attributes.");
  }
  return attributes;
}

export function parseAiVoiceXmpPacket(packet: Buffer): AiVoiceXmpMetadata {
  assertBoundedPacket(packet);
  const xml = packet.toString("utf8");
  if (Buffer.byteLength(xml, "utf8") !== packet.length || /<!DOCTYPE|<!ENTITY|\0/i.test(xml)) {
    throw new Error("XMP packet contains invalid or unsafe XML.");
  }
  const match = xml.match(
    /^<\?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"\?><x:xmpmeta xmlns:x="adobe:ns:meta\/">\s*<rdf:RDF xmlns:rdf="http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#">\s*<rdf:Description\s+([\s\S]*?)\s*\/><\/rdf:RDF>\s*<\/x:xmpmeta><\?xpacket end="w"\?>$/,
  );
  if (!match?.[1]) throw new Error("XMP packet does not match the StoryCapture AI voice schema.");

  const attributes = parseDescriptionAttributes(match[1]);
  if (attributes.size !== Object.keys(DESCRIPTION_ATTRIBUTE_VALUES).length) {
    throw new Error("XMP packet contains unapproved metadata fields.");
  }
  for (const [name, expected] of Object.entries(DESCRIPTION_ATTRIBUTE_VALUES)) {
    if (attributes.get(name) !== expected) {
      throw new Error(`XMP ${name} is ${attributes.get(name) ?? "missing"}; expected ${expected}.`);
    }
  }
  return {
    creatorTool: XMP_CREATOR_TOOL,
    format: XMP_FORMAT,
    containsAiGeneratedVoice: true,
    generationMethod: XMP_GENERATION_METHOD,
  };
}

export async function readAdobeXmpMetadata(filePath: string): Promise<AiVoiceXmpMetadata | null> {
  const stat = await fs.stat(filePath);
  const file = await fs.open(filePath, "r");
  try {
    let offset = 0;
    let metadata: AiVoiceXmpMetadata | null = null;
    const header = Buffer.alloc(32);
    while (offset + 8 <= stat.size) {
      const { bytesRead } = await file.read(header, 0, header.length, offset);
      if (bytesRead < 8) throw new Error("MP4 ends with a truncated top-level box.");
      const size32 = header.readUInt32BE(0);
      const headerSize = size32 === 1 ? 16 : 8;
      if (size32 === 1 && bytesRead < 16)
        throw new Error("MP4 has a truncated extended box header.");
      const boxSize =
        size32 === 0
          ? stat.size - offset
          : size32 === 1
            ? Number(header.readBigUInt64BE(8))
            : size32;
      if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > stat.size) {
        throw new Error("MP4 contains an invalid top-level box size.");
      }
      const type = header.toString("ascii", 4, 8);
      if (type === "uuid") {
        const uuidOffset = size32 === 1 ? 16 : 8;
        if (boxSize < uuidOffset + ADOBE_XMP_UUID.length || bytesRead < uuidOffset + 16) {
          throw new Error("MP4 contains a truncated UUID box.");
        }
        const uuid = header.subarray(uuidOffset, uuidOffset + 16);
        if (uuid.equals(ADOBE_XMP_UUID)) {
          if (metadata) throw new Error("MP4 contains more than one Adobe XMP UUID box.");
          const packetSize = boxSize - uuidOffset - 16;
          if (packetSize <= 0 || packetSize > MAX_XMP_PACKET_BYTES) {
            throw new Error(`Adobe XMP packet is ${packetSize} bytes; outside the allowed bound.`);
          }
          const packet = Buffer.allocUnsafe(packetSize);
          const packetRead = await file.read(packet, 0, packetSize, offset + uuidOffset + 16);
          if (packetRead.bytesRead !== packetSize)
            throw new Error("Adobe XMP packet is truncated.");
          metadata = parseAiVoiceXmpPacket(packet);
        }
      }
      offset += boxSize;
    }
    if (offset !== stat.size) throw new Error("MP4 ends with trailing bytes outside a box.");
    return metadata;
  } finally {
    await file.close();
  }
}

export async function appendAiVoiceXmpToMp4(filePath: string): Promise<void> {
  if (await readAdobeXmpMetadata(filePath)) {
    throw new Error("MP4 already contains Adobe XMP metadata.");
  }
  await fs.appendFile(filePath, buildAdobeXmpUuidBox());
  if (!(await readAdobeXmpMetadata(filePath))) {
    throw new Error("Appended Adobe XMP UUID box is not readable as top-level MP4 metadata.");
  }
}
