import { resolveAppPaths } from './app-paths';

const appPaths = resolveAppPaths();

export const paths = {
  ...appPaths,
  cacheDir: appPaths.rootDir,
  processesFile: appPaths.userRegistryFile,
  /** User-owned wrapper for the bridge's exec-provider secret resolver. */
};
