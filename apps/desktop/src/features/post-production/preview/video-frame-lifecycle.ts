/**
 * VideoFrame lifecycle helper.
 *
 * WebCodecs `VideoFrame` objects hold GPU-backed buffers that must be
 * explicitly released via `.close()`. Missing even one close() in an
 * error path leaks a frame per render tick and crashes the preview
 * within ~30s. This helper enforces the acquire/use/close contract via
 * try/finally so callers cannot forget.
 *
 * The finally block defends against double-close (spec-compliant close()
 * is idempotent in practice but some polyfills throw) by swallowing
 * errors.
 */

export type FrameAcquireFn = () => Promise<VideoFrame>;

export async function withVideoFrame<T>(
  acquire: FrameAcquireFn,
  use: (f: VideoFrame) => Promise<T>,
): Promise<T> {
  const frame = await acquire();
  try {
    return await use(frame);
  } finally {
    try {
      frame.close();
    } catch {
      /* already closed — swallow */
    }
  }
}
