/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build-baked app version (see lib/version.ts); undefined in dev/test builds. */
  readonly VITE_APP_VERSION?: string;
}
