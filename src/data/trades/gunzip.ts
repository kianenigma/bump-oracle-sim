import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Download a gzipped resource and return its uncompressed text.
 *
 * Mirrors the binance.ts download pattern: read the body to an ArrayBuffer
 * first (workaround for Bun.write hanging on response streams), persist to
 * a temp file, then shell out to `gunzip` and read the result.
 *
 * Returns the unzipped text. Cleans up the temp .gz file on success and on
 * error. Caller decides what to do with the (possibly very large) string.
 */
export async function downloadAndGunzip(url: string, label: string): Promise<{
  text: string;
  zipBytes: number;
  csvBytes: number;
  downloadMs: number;
  unzipMs: number;
}> {
  const tStart = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label}: fetch ${url} failed with ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  const tmp = join(tmpdir(), `oracle-sim-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.gz`);
  await Bun.write(tmp, buf);
  const downloadMs = Date.now() - tStart;

  try {
    const proc = Bun.spawn(["gunzip", "-c", tmp]);
    const text = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`${label}: gunzip exited with code ${exit} for ${url}`);
    const unzipMs = Date.now() - tStart - downloadMs;
    return {
      text,
      zipBytes: buf.byteLength,
      csvBytes: text.length,
      downloadMs,
      unzipMs,
    };
  } finally {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
  }
}
