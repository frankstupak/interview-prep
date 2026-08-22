// bench.ts — before/after benchmarks for the validation uplift
// Run: npx tsx bench.ts
/* eslint-disable no-console */
import { z } from "zod";
import { ValidationEngine as OriginalEngine } from "./bench-original-engine";
import { ValidationEngine as UpliftedEngine } from "./src/validation-engine";

const paginationLike = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive().max(100),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]),
});
const payload = { page: 3, limit: 20, sortBy: "created", sortOrder: "desc", junk: "stripped" };

interface BenchEngine {
  validate(schema: z.ZodType<unknown, z.ZodTypeDef, unknown>, data: unknown): Promise<unknown>;
}

async function throughput(name: string, engine: BenchEngine, iters: number): Promise<number> {
  // warmup
  for (let i = 0; i < 2000; i++) await engine.validate(paginationLike, payload);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await engine.validate(paginationLike, payload);
  const ms = performance.now() - t0;
  const ops = (iters / ms) * 1000;
  console.log(`${name}: ${ms.toFixed(0)}ms for ${iters} validations = ${Math.round(ops).toLocaleString()} ops/s`);
  return ops;
}

async function batchBench(): Promise<void> {
  const DELAY = 5;
  const ITEMS = 200;
  const schema = z.object({ v: z.number() }).refine(async (p) => {
    await new Promise((r) => setTimeout(r, DELAY));
    return p.v >= 0;
  });
  const data = Array.from({ length: ITEMS }, (_, i) => ({ v: i }));

  const orig = new OriginalEngine({ logValidationErrors: false });
  const up = new UpliftedEngine({ logValidationErrors: false });

  let t = performance.now();
  await orig.validateBatch(schema, data);
  const tOrig = performance.now() - t;

  t = performance.now();
  await up.validateBatch(schema, data, undefined, undefined, { concurrency: 32 });
  const tConc = performance.now() - t;

  console.log(`batch ${ITEMS} items x ${DELAY}ms async refine:`);
  console.log(`  original (sequential):      ${tOrig.toFixed(0)}ms`);
  console.log(`  uplifted (concurrency=32):  ${tConc.toFixed(0)}ms  -> ${(tOrig / tConc).toFixed(1)}x`);
}

async function main(): Promise<void> {
  const ITERS = 200_000;
  console.log(`single-validate throughput (sync object schema, stripUnknown default, ${ITERS.toLocaleString()} iters):`);
  const o = await throughput("  original", new OriginalEngine({ logValidationErrors: false }), ITERS);
  const u = await throughput("  uplifted", new UpliftedEngine({ logValidationErrors: false }), ITERS);
  console.log(`  speedup: ${(u / o).toFixed(2)}x`);
  console.log();
  await batchBench();
}
main();
