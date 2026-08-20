// Runs one src/lib/<name>.test.ts without a test framework.
//
//   node run_test.mjs fft | plotData | throttle      (see package.json)
//
// esbuild is already a Vite dependency, so this adds nothing to
// package.json. The bundle goes to the OS temp dir so it never lands in the
// working tree, and the child's exit code becomes ours so a failing check
// fails the command.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = process.argv[2];
if (!name) {
  console.error("usage: node run_test.mjs <name>   (e.g. fft, plotData, throttle)");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), `${name}-test-`));
try {
  const out = join(dir, `${name}.test.cjs`);
  await build({
    entryPoints: [`src/lib/${name}.test.ts`],
    bundle: true,
    platform: "node",
    outfile: out,
    logLevel: "warning",
  });
  process.exitCode = spawnSync(process.execPath, [out], { stdio: "inherit" }).status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
