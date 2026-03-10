import { join } from "path";
import type {
  SimDataFile,
  ApiMetaResponse,
  ApiDataResponse,
} from "../types.js";
import { aggregateOHLC, aggregateLine, aggregateDeviation } from "./aggregation.js";

const TEMPLATE_PATH = join(import.meta.dir, "template.html");
const MAX_CANDLES = 10_000;
const OVER_FETCH_RATIO = 0.1; // 10% padding on each side

const TIMEFRAMES = [6, 60, 900, 3600, 21600, 43200, 86400, 604800];

function nextTF(tf: number): number {
  for (const t of TIMEFRAMES) {
    if (t > tf) return t;
  }
  return TIMEFRAMES[TIMEFRAMES.length - 1];
}

function buildMetaResponse(data: SimDataFile): ApiMetaResponse {
  return {
    scenarioCount: data.scenarios.length,
    scenarios: data.scenarios.map((s, i) => ({
      index: i,
      config: s.config,
      summary: s.summary,
      timeRange: {
        from: s.timestamps[0],
        to: s.timestamps[s.timestamps.length - 1],
      },
      blockCount: s.timestamps.length,
    })),
  };
}

function buildDataResponse(
  data: SimDataFile,
  from: number,
  to: number,
  tf: number,
  scenarioFilter: string
): ApiDataResponse {
  const requestedTF = tf;

  // Add over-fetch padding
  const span = to - from;
  const pad = span * OVER_FETCH_RATIO;
  const paddedFrom = from - pad;
  const paddedTo = to + pad;

  // Auto-upgrade TF if too many candles
  const windowSpan = paddedTo - paddedFrom;
  while (windowSpan / tf > MAX_CANDLES && tf < TIMEFRAMES[TIMEFRAMES.length - 1]) {
    tf = nextTF(tf);
  }

  // Use first scenario for real price (they all share the same real price data)
  const firstScenario = data.scenarios[0];
  const realOhlc = aggregateOHLC(firstScenario.timestamps, firstScenario.realPrices, paddedFrom, paddedTo, tf);
  const realLine = aggregateLine(firstScenario.timestamps, firstScenario.realPrices, paddedFrom, paddedTo, tf);

  // Determine which scenarios to include
  let scenarioIndices: number[];
  if (scenarioFilter === "all") {
    scenarioIndices = data.scenarios.map((_, i) => i);
  } else {
    const idx = parseInt(scenarioFilter);
    scenarioIndices = isNaN(idx) ? data.scenarios.map((_, i) => i) : [idx];
  }

  const oracles = scenarioIndices.map((idx) => {
    const s = data.scenarios[idx];
    return {
      index: idx,
      label: s.config.label,
      ohlc: aggregateOHLC(s.timestamps, s.oraclePrices, paddedFrom, paddedTo, tf),
      line: aggregateLine(s.timestamps, s.oraclePrices, paddedFrom, paddedTo, tf),
      deviation: aggregateDeviation(s.timestamps, s.deviationPcts, paddedFrom, paddedTo, tf),
    };
  });

  return {
    tf,
    requestedTF,
    from: paddedFrom,
    to: paddedTo,
    realPrice: { ohlc: realOhlc, line: realLine },
    oracles,
  };
}

export async function startServer(
  data: SimDataFile,
  port: number,
  openBrowser: boolean
): Promise<void> {
  const templateHtml = await Bun.file(TEMPLATE_PATH).text();
  const metaResponse = JSON.stringify(buildMetaResponse(data));

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(templateHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/meta") {
        return new Response(metaResponse, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (url.pathname === "/api/data") {
        const scenario = url.searchParams.get("scenario") ?? "all";
        const from = parseFloat(url.searchParams.get("from") ?? "0");
        const to = parseFloat(url.searchParams.get("to") ?? String(Date.now() / 1000));
        const tf = parseInt(url.searchParams.get("tf") ?? "900");

        if (isNaN(from) || isNaN(to) || isNaN(tf)) {
          return new Response(JSON.stringify({ error: "Invalid parameters" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const result = buildDataResponse(data, from, to, tf, scenario);
        return new Response(JSON.stringify(result), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://localhost:${server.port}`;
  console.log(`Server running at ${url}`);

  if (openBrowser) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  }

  console.log("Press Ctrl+C to stop the server.");

  // Keep process alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\nStopping server...");
      server.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });
}
