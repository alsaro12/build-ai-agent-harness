import type { Sandbox } from "./sandbox.js";

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function detectPackageRunner(pkg: PackageJson): "npm" | "pnpm" | "yarn" | "bun" {
  const packageManager = pkg.packageManager || "";

  if (packageManager.startsWith("pnpm@")) return "pnpm";
  if (packageManager.startsWith("yarn@")) return "yarn";
  if (packageManager.startsWith("bun@")) return "bun";

  return "npm";
}

function scriptCommand(
  runner: "npm" | "pnpm" | "yarn" | "bun",
  script: string,
): string {
  if (runner === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }

  if (runner === "bun") {
    return `bun run ${script}`;
  }

  return `${runner} ${script}`;
}

export async function discoverGates(sandbox: Sandbox): Promise<string[]> {
  try {
    const raw = await sandbox.readFile("package.json");
    const pkg = JSON.parse(raw) as PackageJson;
    const scripts = pkg.scripts ?? {};
    const runner = detectPackageRunner(pkg);
    const gates: string[] = [];
    const typeScriptInstalled = Boolean(
      pkg.dependencies?.typescript || pkg.devDependencies?.typescript,
    );
    const typeCheckScript = scripts.typecheck
      ? "typecheck"
      : scripts["type-check"]
        ? "type-check"
        : undefined;

    if (typeCheckScript) {
      gates.push(scriptCommand(runner, typeCheckScript));
    } else if (typeScriptInstalled) {
      gates.push("npx tsc --noEmit");
    }

    if (scripts.lint) gates.push(scriptCommand(runner, "lint"));
    if (scripts.test) gates.push(scriptCommand(runner, "test"));
    if (scripts.build) gates.push(scriptCommand(runner, "build"));

    return gates;
  } catch {
    return [];
  }
}
