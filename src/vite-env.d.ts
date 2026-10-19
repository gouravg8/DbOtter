/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev bridge URL for running the UI in a plain browser, e.g. http://127.0.0.1:1430 */
  readonly VITE_DBOTTER_BRIDGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
