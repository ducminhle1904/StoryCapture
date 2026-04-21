export interface ProjectAccent {
  hue: number;
  hash: string;
}

export function projectAccent(id: string): ProjectAccent {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  const hash = h.toString(16).padStart(6, "0").slice(0, 3);
  return { hue, hash };
}
