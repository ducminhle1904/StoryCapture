import { maximumColorDelta, sampleBgra } from "./export-quality-gate";

function assertFrame(frame: Buffer, width: number, height: number): void {
  if (width <= 0 || height <= 0 || frame.byteLength !== width * height * 4) {
    throw new Error(`Invalid BGRA frame for ${width}x${height} quality analysis.`);
  }
}

function lumaAt(frame: Buffer, width: number, x: number, y: number): number {
  const offset = (y * width + x) * 4;
  return 0.0722 * frame[offset] + 0.7152 * frame[offset + 1] + 0.2126 * frame[offset + 2];
}

function transitionWidth(samples: number[]): number | null {
  const minimum = Math.min(...samples);
  const maximum = Math.max(...samples);
  if (maximum - minimum < 32) return null;
  const increasing = (samples.at(-1) ?? 0) >= (samples[0] ?? 0);
  const normalized = samples.map((sample) => {
    const value = (sample - minimum) / (maximum - minimum);
    return increasing ? value : 1 - value;
  });
  let violations = 0;
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    if ((normalized[index + 1] ?? 0) + 0.08 < (normalized[index] ?? 0)) violations += 1;
  }
  if (violations > 2) return null;
  const low = normalized.findIndex((value) => value >= 0.1);
  const high = normalized.findIndex((value) => value >= 0.9);
  return low < 0 || high < low ? null : high - low;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  values.sort((left, right) => left - right);
  return values[Math.floor((values.length - 1) * ratio)] ?? 0;
}

export function runtimeEdgeSpreadIncrease(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
): number {
  assertFrame(reference, width, height);
  assertFrame(actual, width, height);
  const radius = 8;
  const margin = Math.min(64, Math.max(radius, Math.floor(Math.min(width, height) / 16)));
  const increases: number[] = [];
  for (const vertical of [false, true]) {
    for (let y = margin; y < height - margin; y += 4) {
      for (let x = margin; x < width - margin; x += 4) {
        const referenceSamples: number[] = [];
        const actualSamples: number[] = [];
        for (let delta = -radius; delta <= radius; delta += 1) {
          const sampleX = vertical ? x : x + delta;
          const sampleY = vertical ? y + delta : y;
          referenceSamples.push(lumaAt(reference, width, sampleX, sampleY));
          actualSamples.push(lumaAt(actual, width, sampleX, sampleY));
        }
        const referenceWidth = transitionWidth(referenceSamples);
        if (referenceWidth === null || referenceWidth > 3) continue;
        const actualWidth = transitionWidth(actualSamples);
        increases.push(
          actualWidth === null ? radius * 2 : Math.max(0, actualWidth - referenceWidth),
        );
      }
    }
  }
  return percentile(increases, 0.99);
}

export function stableColorChannelDelta(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
): number {
  assertFrame(reference, width, height);
  assertFrame(actual, width, height);
  const margin = Math.min(64, Math.max(4, Math.floor(Math.min(width, height) / 16)));
  const stride = Math.min(64, Math.max(8, Math.floor(Math.min(width, height) / 16)));
  const deltas: number[] = [];
  for (let y = margin; y < height - margin; y += stride) {
    for (let x = margin; x < width - margin; x += stride) {
      const colors = [-2, 0, 2].flatMap((deltaY) =>
        [-2, 0, 2].map((deltaX) => sampleBgra(reference, width, height, x + deltaX, y + deltaY)),
      );
      const channelRange = (channel: "blue" | "green" | "red") =>
        Math.max(...colors.map((color) => color[channel])) -
        Math.min(...colors.map((color) => color[channel]));
      if (Math.max(channelRange("blue"), channelRange("green"), channelRange("red")) > 2) continue;
      deltas.push(
        maximumColorDelta(
          sampleBgra(reference, width, height, x, y),
          sampleBgra(actual, width, height, x, y),
        ),
      );
    }
  }
  if (deltas.length > 0) return percentile(deltas, 0.5);
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  return maximumColorDelta(
    sampleBgra(reference, width, height, centerX, centerY),
    sampleBgra(actual, width, height, centerX, centerY),
  );
}
