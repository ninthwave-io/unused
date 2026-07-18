// Criterion 4 — throughput sanity (NOT a benchmark; an order-of-magnitude number
// for docs/bench later, per the M2 bench harness).
//
// A ~300-line realistic TS file is parsed 200x. Each iteration uses a FRESH string
// (unique prepended comment) so nothing can be served from a string-identity cache.
// oxc-parser's parseSync has no internal parse cache, but this keeps the number honest.

import { parseSync } from 'oxc-parser';
import assert from 'node:assert';

// ---- build a ~300-line realistic TS module ----------------------------------
function makeSource() {
  const header = `import { readFile } from 'node:fs/promises';
import type { Logger, Config } from './types.js';
import { Emitter } from './emitter.js';
import * as util from './util.js';

export interface Entity {
  id: string;
  name: string;
  tags: readonly string[];
  meta?: Record<string, unknown>;
}
`;
  const blocks = [];
  for (let i = 0; i < 8; i++) {
    blocks.push(`
export type Handler${i}<T extends Entity> = (input: T, cfg: Config) => Promise<Result${i}>;

export interface Result${i} {
  ok: boolean;
  value: number;
  detail: Partial<Entity>;
}

export class Service${i} extends Emitter implements Logger {
  private readonly cache = new Map<string, Result${i}>();
  constructor(private readonly cfg: Config) { super(); }

  async run(entity: Entity): Promise<Result${i}> {
    const key = entity.id + ':${i}';
    const hit = this.cache.get(key);
    if (hit) return hit;
    const value = await this.compute(entity, ${i});
    const result: Result${i} = { ok: value > 0, value, detail: { id: entity.id } };
    this.cache.set(key, result);
    return result;
  }

  private async compute(entity: Entity, salt: number): Promise<number> {
    const raw = await readFile(entity.name, 'utf8');
    return util.hash(raw) + salt + entity.tags.length;
  }

  log(msg: string): void { console.log('[Service${i}]', msg); }
}

export function make${i}(cfg: Config): Service${i} {
  return new Service${i}(cfg);
}
`);
  }
  return header + blocks.join('');
}

const base = makeSource();
const lineCount = base.split('\n').length;
assert.ok(lineCount >= 280 && lineCount <= 360, `expected ~300 lines, got ${lineCount}`);

// sanity: it parses clean
assert.equal(parseSync('bench.ts', base, { lang: 'ts' }).errors.length, 0);

// ---- timed loop -------------------------------------------------------------
const N = 200;
// warmup (JIT) — not counted
for (let i = 0; i < 20; i++) parseSync('warm.ts', `// w${i}\n` + base, { lang: 'ts' });

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const fresh = `// iteration ${i} unique ${Math.random()}\n` + base; // fresh string each time
  const res = parseSync('bench.ts', fresh, { lang: 'ts' });
  if (res.errors.length) throw new Error('unexpected parse error');
}
const ms = performance.now() - t0;

const msPerFile = ms / N;
const filesPerSec = 1000 / msPerFile;
console.log(`file: ~${lineCount} lines, ${base.length} bytes`);
console.log(`parsed ${N} files in ${ms.toFixed(1)} ms`);
console.log(`-> ${msPerFile.toFixed(3)} ms/file, ${Math.round(filesPerSec).toLocaleString()} files/sec (parse only, single-threaded)`);
console.log('\nOK 04 — throughput sanity number recorded.');
