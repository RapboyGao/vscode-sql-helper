type VsCodeApi = {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

export function getVsCodeApi(): VsCodeApi | undefined {
  return window.acquireVsCodeApi?.();
}

