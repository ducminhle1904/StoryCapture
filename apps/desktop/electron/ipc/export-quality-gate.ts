export interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BgraColor {
  blue: number;
  green: number;
  red: number;
}

function luma(frame: Buffer, pixel: number): number {
  const offset = pixel * 4;
  return 0.0722 * frame[offset] + 0.7152 * frame[offset + 1] + 0.2126 * frame[offset + 2];
}

function assertFrameSize(frame: Buffer, width: number, height: number): void {
  const expectedBytes = width * height * 4;
  if (frame.byteLength !== expectedBytes) {
    throw new Error(`BGRA frame has ${frame.byteLength} bytes; expected ${expectedBytes}.`);
  }
}

export function frameSsim(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
): number {
  assertFrameSize(reference, width, height);
  assertFrameSize(actual, width, height);
  const blockSize = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let blocks = 0;
  for (let y = 0; y < height; y += blockSize) {
    for (let x = 0; x < width; x += blockSize) {
      let count = 0;
      let sumReference = 0;
      let sumActual = 0;
      let sumReferenceSquared = 0;
      let sumActualSquared = 0;
      let sumProduct = 0;
      for (let dy = 0; dy < blockSize && y + dy < height; dy += 1) {
        for (let dx = 0; dx < blockSize && x + dx < width; dx += 1) {
          const pixel = (y + dy) * width + x + dx;
          const referenceValue = luma(reference, pixel);
          const actualValue = luma(actual, pixel);
          count += 1;
          sumReference += referenceValue;
          sumActual += actualValue;
          sumReferenceSquared += referenceValue ** 2;
          sumActualSquared += actualValue ** 2;
          sumProduct += referenceValue * actualValue;
        }
      }
      const meanReference = sumReference / count;
      const meanActual = sumActual / count;
      const varianceReference = sumReferenceSquared / count - meanReference ** 2;
      const varianceActual = sumActualSquared / count - meanActual ** 2;
      const covariance = sumProduct / count - meanReference * meanActual;
      total +=
        ((2 * meanReference * meanActual + c1) * (2 * covariance + c2)) /
        ((meanReference ** 2 + meanActual ** 2 + c1) * (varianceReference + varianceActual + c2));
      blocks += 1;
    }
  }
  return total / blocks;
}

export function findPixelBounds(
  frame: Buffer,
  width: number,
  height: number,
  matches: (color: BgraColor) => boolean,
): PixelBounds | null {
  assertFrameSize(frame, width, height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (
        !matches({
          blue: frame[offset],
          green: frame[offset + 1],
          red: frame[offset + 2],
        })
      ) {
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right >= 0 ? { left, top, right, bottom } : null;
}

export function maximumBoundsDelta(reference: PixelBounds, actual: PixelBounds): number {
  return Math.max(
    Math.abs(reference.left - actual.left),
    Math.abs(reference.top - actual.top),
    Math.abs(reference.right - actual.right),
    Math.abs(reference.bottom - actual.bottom),
  );
}

export function sampleBgra(frame: Buffer, width: number, height: number, x: number, y: number) {
  assertFrameSize(frame, width, height);
  if (x < 0 || x >= width || y < 0 || y >= height) {
    throw new Error(`Sample coordinate ${x},${y} is outside ${width}x${height}.`);
  }
  const offset = (y * width + x) * 4;
  return {
    blue: frame[offset],
    green: frame[offset + 1],
    red: frame[offset + 2],
  } satisfies BgraColor;
}

export function maximumColorDelta(reference: BgraColor, actual: BgraColor): number {
  return Math.max(
    Math.abs(reference.blue - actual.blue),
    Math.abs(reference.green - actual.green),
    Math.abs(reference.red - actual.red),
  );
}
