import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";

type PackageJson = {
  name?: unknown;
  version?: unknown;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  license?: unknown;
  description?: unknown;
  repository?: { url?: string } | string;
  keywords?: unknown;
  scripts?: Record<string, string>;
};

const projectRoot = join(import.meta.dir, "..");
const packageJsonPath = join(projectRoot, "package.json");
const distCliPath = join(projectRoot, "dist", "cli.js");
const licensePath = join(projectRoot, "LICENSE");

async function loadPackageJson(): Promise<PackageJson> {
  return (await Bun.file(packageJsonPath).json()) as PackageJson;
}

describe("package.json fields", () => {
  let packageJson: PackageJson;

  beforeAll(async () => {
    packageJson = await loadPackageJson();
  });

  test("name is auto-bmad", () => {
    expect(packageJson.name).toBe("auto-bmad");
  });

  test("version matches semver", () => {
    expect(typeof packageJson.version).toBe("string");
    expect(String(packageJson.version)).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  });

  test("bin points to dist/cli.js", () => {
    expect(packageJson.bin?.autobmad).toBe("./dist/cli.js");
  });

  test("files includes dist", () => {
    expect(Array.isArray(packageJson.files)).toBe(true);
    expect(packageJson.files).toContain("dist");
  });

  test("engines.bun requires bun >=1.0.0", () => {
    expect(packageJson.engines?.bun).toBe(">=1.0.0");
  });

  test("license is MIT", () => {
    expect(packageJson.license).toBe("MIT");
  });

  test("description is non-empty", () => {
    expect(typeof packageJson.description).toBe("string");
    expect(String(packageJson.description).trim().length).toBeGreaterThan(0);
  });

  test("repository URL references AutoBMAD", () => {
    const repositoryUrl =
      typeof packageJson.repository === "string"
        ? packageJson.repository
        : packageJson.repository?.url;
    expect(repositoryUrl).toContain("AutoBMAD");
  });

  test("keywords is a non-empty array", () => {
    expect(Array.isArray(packageJson.keywords)).toBe(true);
    expect((packageJson.keywords as unknown[]).length).toBeGreaterThan(0);
  });

  test("prepublishOnly runs build", () => {
    expect(packageJson.scripts?.prepublishOnly).toBe("bun run build");
  });
});

describe("build output", () => {
  beforeAll(async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
      throw new Error(`Build failed with code ${exitCode}\n${stdout}\n${stderr}`);
    }
  });

  test("dist/cli.js exists", async () => {
    expect(await Bun.file(distCliPath).exists()).toBe(true);
  });

  test("dist/cli.js has bun shebang", async () => {
    const text = await Bun.file(distCliPath).text();
    expect(text.startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  test("dist/cli.js is not an empty stub", async () => {
    expect(Bun.file(distCliPath).size).toBeGreaterThan(100);
  });

  test("dist/cli.js is executable", async () => {
    const result = await Bun.$`test -x ${distCliPath}`.nothrow();
    expect(result.exitCode).toBe(0);
  });
});

describe("LICENSE", () => {
  test("LICENSE exists", async () => {
    expect(await Bun.file(licensePath).exists()).toBe(true);
  });

  test("LICENSE includes MIT text", async () => {
    const content = await Bun.file(licensePath).text();
    expect(content).toContain("MIT");
  });
});

describe("no source file leakage", () => {
  test("package files does not include source directories", async () => {
    const packageJson = await loadPackageJson();
    const files = packageJson.files ?? [];

    for (const forbidden of ["src", "tests", "scripts"]) {
      expect(files).not.toContain(forbidden);
      expect(files.some((entry) => entry.startsWith(`${forbidden}/`))).toBe(false);
    }
  });
});
