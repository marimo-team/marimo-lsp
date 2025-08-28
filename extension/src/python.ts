import * as py from "@vscode/python-extension";

let api: py.PythonExtension | undefined;

/**
 * Get cached Python Extension API.
 */
export async function getPythonApi(): Promise<py.PythonExtension> {
  if (!api) {
    api = await py.PythonExtension.api();
  }
  return api;
}
