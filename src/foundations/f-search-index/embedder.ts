/**
 * The local embedding model (transformers.js, an optional dependency). Loads in the background;
 * until it is ready, or when it cannot load (not installed, offline, proxy, sandbox), `embedder()`
 * returns null and search is keyword-only. A tool call never waits on the download. The reason a
 * model is unavailable is logged once to stderr; nothing here writes to stdout.
 */

import * as os from "os";
import * as path from "path";

/** Default model: English, 384 dimensions, quantized. */
export const DEFAULT_SEARCH_MODEL = "Xenova/bge-small-en-v1.5";

/** Known models: pooling, and the instruction bge models put before a query. */
const MODEL_PROFILES: Record<string, { pooling: "cls" | "mean"; queryPrefix: string }> = {
  "Xenova/bge-small-en-v1.5": {
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "Xenova/all-MiniLM-L6-v2": { pooling: "mean", queryPrefix: "" },
};

export interface ModelProfile {
  model: string;
  pooling: "cls" | "mean";
  queryPrefix: string;
}

/** Profile of a model id; an unknown model is mean-pooled (its vector size is read on load). */
export function modelProfile(model: string): ModelProfile {
  const known = MODEL_PROFILES[model];
  return known ? { model, ...known } : { model, pooling: "mean", queryPrefix: "" };
}

/** What embeds text: the transformers.js model, or a test double with the same shape. */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** Unit vectors, one per text. `query` texts get the model's query instruction. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

/** Where models are stored: once per machine, not per project. */
export function modelCacheDir(): string {
  return process.env.MINDPLAN_MODEL_CACHE ?? path.join(os.homedir(), ".cache", "mindplan", "models");
}

type Extractor = (
  texts: string[],
  opts: { pooling: "cls" | "mean"; normalize: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

type ModelState =
  | { status: "loading"; promise: Promise<void> }
  | { status: "ready"; embedder: Embedder }
  | { status: "failed"; reason: string };

const models = new Map<string, ModelState>();
const logged = new Set<string>();

function logOnce(key: string, message: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.error(`MindPlan search: ${message}`);
}

/** Run one model call at a time; the pipeline is not reentrant. */
function serialize(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function loadModel(profile: ModelProfile, allowRemote: boolean): Promise<Embedder> {
  // A dynamic import keeps the optional dependency out of the load path of every other module;
  // the specifier is a variable so the build does not need the package installed.
  const specifier = "@huggingface/transformers";
  const lib = (await import(specifier)) as unknown as {
    env: Record<string, unknown> & { backends?: { onnx?: Record<string, unknown> } };
    pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<Extractor>;
  };
  // Downloads land in cacheDir; offline, the same folder is read as the local model path, because
  // transformers.js refuses to run with both local and remote models disabled.
  lib.env.cacheDir = modelCacheDir();
  lib.env.localModelPath = modelCacheDir();
  lib.env.allowRemoteModels = allowRemote;
  lib.env.allowLocalModels = !allowRemote;
  if (lib.env.backends?.onnx) lib.env.backends.onnx.logLevel = "error";
  const extractor = await lib.pipeline("feature-extraction", profile.model, { dtype: "q8" });
  const queue = serialize();
  const run = (texts: string[]) =>
    queue(async () => {
      const out = await extractor(texts, { pooling: profile.pooling, normalize: true });
      const dims = out.dims[out.dims.length - 1];
      const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    });
  const probe = await run(["warm up"]);
  const dims = probe[0].length;
  return {
    model: profile.model,
    dims,
    async embed(texts, kind) {
      const input = kind === "query" ? texts.map((t) => profile.queryPrefix + t) : texts;
      const vectors: Float32Array[] = [];
      for (let i = 0; i < input.length; i += 32) vectors.push(...(await run(input.slice(i, i + 32))));
      return vectors;
    },
  };
}

/**
 * Start loading `model` in the background (no-op when it is loading, ready, or failed). The
 * returned promise settles when loading ends and never rejects.
 */
export function warmModel(model: string): Promise<void> {
  const state = models.get(model);
  if (state?.status === "loading") return state.promise;
  if (state) return Promise.resolve();
  const allowRemote = process.env.MINDPLAN_SEARCH_OFFLINE !== "1";
  const promise = loadModel(modelProfile(model), allowRemote).then(
    (embedder) => {
      models.set(model, { status: "ready", embedder });
    },
    (err: unknown) => {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      models.set(model, { status: "failed", reason });
      logOnce(`model:${model}`, `semantic search is off (${model} could not load: ${reason}); keyword ranking only.`);
    }
  );
  models.set(model, { status: "loading", promise });
  return promise;
}

/** The ready embedder for `model`, or null while it loads or after it failed. */
export function readyEmbedder(model: string): Embedder | null {
  const state = models.get(model);
  return state?.status === "ready" ? state.embedder : null;
}

/** Status of a model for diagnostics: not started, loading, ready, or failed with a reason. */
export function modelStatus(model: string): { status: "idle" | "loading" | "ready" | "failed"; reason?: string } {
  const state = models.get(model);
  if (!state) return { status: "idle" };
  if (state.status === "failed") return { status: "failed", reason: state.reason };
  return { status: state.status };
}
