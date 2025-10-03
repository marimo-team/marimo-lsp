import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { Commands } from "../constants.ts";

describe("constants", () => {
  it("Commands in constants.ts must exactly match commands in package.json", () => {
    // Extract command IDs from package.json
    const packageCommands = new Set(
      packageJson.contributes.commands.map((cmd) => cmd.command),
    );

    // Extract command IDs from constants.ts
    const constantCommands = new Set<string>(Object.values(Commands));

    // Check that all commands from constants.ts appear in package.json
    for (const cmd of constantCommands) {
      expect(
        packageCommands.has(cmd),
        `Command "${cmd}" from constants.ts is missing in package.json`,
      ).toBe(true);
    }

    // Check that all commands from package.json appear in constants.ts
    for (const cmd of packageCommands) {
      expect(
        constantCommands.has(cmd),
        `Command "${cmd}" from package.json is missing in constants.ts`,
      ).toBe(true);
    }

    // Verify they are exactly equal (same length)
    expect(constantCommands.size).toBe(packageCommands.size);
  });
});
