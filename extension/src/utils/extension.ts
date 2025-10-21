export const EXTENSION_PACKAGE = {
  publisher: "marimo-team",
  name: "vscode-marimo",
  get fullName(): string {
    return `${this.publisher}.${this.name}`;
  },
};
