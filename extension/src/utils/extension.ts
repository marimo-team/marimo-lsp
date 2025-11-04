export const EXTENSION_PACKAGE = {
  publisher: "marimo-team" as const,
  name: "vscode-marimo" as const,
  get fullName() {
    return `${this.publisher}.${this.name}` as const;
  },
};
