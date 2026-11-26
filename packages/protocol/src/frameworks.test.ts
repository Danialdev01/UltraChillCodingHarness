import { describe, expect, it } from "vitest";

import {
  FRAMEWORK_IDS,
  FRAMEWORK_PROFILES,
  fillScaffold,
  frameworkChoiceError,
  frameworkForStack,
  planFramework,
  resolveFrameworkOptions,
  scaffoldNames,
} from "./frameworks.js";
import { PROJECT_COMMAND_LABEL_MAX, PROJECT_COMMAND_MAX, PROJECT_COMMANDS_MAX } from "./project-command-limits.js";
import { ProjectCommand } from "./project-commands.js";
import { RUNTIME_IDS, RUNTIME_SELECTION_PATTERN } from "./runtime-names.js";
import { FrameworkFile } from "./framework-file.js";

describe("framework profiles (plan3 §1.5)", () => {
  it.each(FRAMEWORK_IDS)("%s at its defaults", (id) => {
    const plan = planFramework(id);
    expect({ runtimes: plan.runtimes, commands: plan.commands.map((c) => `${c.id}: ${c.command}`), env: plan.env, processEnv: plan.processEnv, previewPort: plan.previewPort }).toMatchSnapshot();
  });

  it.each(FRAMEWORK_IDS)("%s writes command buttons commands.json accepts, under every limit, for every choice", (id) => {
    const profile = FRAMEWORK_PROFILES[id];
    // Each option at each of its choices, the rest at defaults.
    const variants: Record<string, unknown>[] = [{}];
    for (const option of profile.options) {
      for (const value of option.kind === "toggle" ? [true, false] : (option.choices ?? []).map((c) => c.value)) variants.push({ [option.key]: value });
    }
    for (const given of variants) {
      const plan = planFramework(id, given);
      expect(new Set(plan.commands.map((c) => c.id)).size).toBe(plan.commands.length);
      expect(plan.commands.length).toBeLessThanOrEqual(PROJECT_COMMANDS_MAX);
      for (const command of plan.commands) {
        expect(ProjectCommand.safeParse(command).success).toBe(true);
        expect(command.label.length).toBeLessThanOrEqual(PROJECT_COMMAND_LABEL_MAX);
        expect(command.command.length).toBeLessThanOrEqual(PROJECT_COMMAND_MAX);
      }
      for (const [runtime, selection] of Object.entries(plan.runtimes)) {
        expect(RUNTIME_IDS).toContain(runtime);
        expect(selection).toMatch(RUNTIME_SELECTION_PATTERN);
      }
      // Plan3 principle 6: the hint stays small.
      expect(new TextEncoder().encode(plan.agentHint).length).toBeLessThanOrEqual(600);
    }
  });

  it("follows the choices", () => {
    expect(planFramework("laravel", { node: "none", queue: false }).commands.map((c) => c.id)).toEqual(["dev", "install", "migrate", "test", "lint"]);
    expect(planFramework("nextjs", { output: "export" })).toMatchObject({ previewPort: null, previewStaticDir: "out" });
    expect(planFramework("nextjs", { runtime: "bun" }).runtimes).toEqual({ bun: "latest", node: "lts" });
    expect(planFramework("aspnet", { sdk: "system" }).runtimes).toEqual({});
    expect(planFramework("rust", { linker: "mold" }).files.map((f) => f.path)).toEqual([".gitignore", ".cargo/config.toml"]);
    expect(planFramework("rust", { sccache: true }).processEnv.RUSTC_WRAPPER).toBe("sccache");
  });

  it("validates a choice: unknown framework, unknown option, bad value", () => {
    expect(frameworkChoiceError("django", {})).toMatch(/not a framework/);
    expect(frameworkChoiceError("rust", { flavour: "x" })).toMatch(/no option flavour/);
    expect(frameworkChoiceError("rust", { watch: "nodemon" })).toMatch(/not one of its choices/);
    expect(frameworkChoiceError("rust", { sccache: "yes" })).toMatch(/on or off/);
    // A version select takes any runtime selection the server may offer.
    expect(frameworkChoiceError("laravel", { php: "8.2" })).toBeNull();
    expect(resolveFrameworkOptions("laravel", { php: "nope" })).toMatchObject({ options: { php: "latest" }, errors: [expect.any(String)] });
  });

  it("maps detected stacks", () => {
    expect(frameworkForStack("dotnet")).toBe("aspnet");
    expect(frameworkForStack("django")).toBeNull();
  });

  it("names a starter from the project's name", () => {
    const names = scaffoldNames("My Shop 2");
    expect(names).toEqual({ dir: "my-shop-2-starter", name: "my-shop-2", Name: "MyShop2" });
    expect(scaffoldNames("42")).toMatchObject({ name: "app", Name: "App" });
    expect(fillScaffold(["dotnet", "new", "webapi", "-o", "{dir}", "-n", "{Name}"], names)).toEqual(["dotnet", "new", "webapi", "-o", "my-shop-2-starter", "-n", "MyShop2"]);
  });
});

describe(".agent/framework.json", () => {
  it("keeps unknown keys, and reads a dismissal", () => {
    expect(FrameworkFile.parse({ framework: "rust", options: { toolchain: "beta" }, extra: 1 })).toMatchObject({ extra: 1 });
    expect(FrameworkFile.parse({ framework: null, dismissed: true })).toMatchObject({ framework: null, options: {} });
    expect(FrameworkFile.safeParse({ framework: "django" }).success).toBe(false);
  });
});
