// Harness driver for the site-generator-speed entry: read every case from
// cases.json in the input directory, answer each one on its own with run()
// from solve.js, and write the answers, in the cases' order, to answers.json
// in the output directory. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in
// for /input and /output outside the sandbox.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house driver runs with V8's incremental marking off, set before
// solve.js loads so all of its work runs under the flag; this entry does
// the same.
setFlagsFromString('--no-incremental-marking');

const solve = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(cases.map((c) => solve.run(c.input))));
