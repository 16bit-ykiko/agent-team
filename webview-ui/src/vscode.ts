interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function getApi(): VsCodeApi | null {
  try {
    return acquireVsCodeApi();
  } catch {
    return null;
  }
}

export const vscode = getApi();

export const isVsCode = vscode !== null;
