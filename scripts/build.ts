export {};

await Bun.$`mkdir -p ./dist`;

const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  outdir: "./dist",
  target: "bun",
  naming: "cli.js",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const content = await Bun.file("./dist/cli.js").text();
await Bun.write("./dist/cli.js", `#!/usr/bin/env bun\n${content}`);

await Bun.$`chmod +x ./dist/cli.js`;

const size = await Bun.file("./dist/cli.js").size;
console.log(`✅ Build successful: dist/cli.js (${(size / 1024).toFixed(1)} KB)`);
