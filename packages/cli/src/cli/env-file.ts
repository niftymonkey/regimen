/**
 * The Regimen-owned config file, re-exported from `@regimen/shared`.
 *
 * The loader itself lives in shared because the capture daemon (an entrypoint
 * in `@regimen/feedback`, which cannot import this package) reads the same file
 * for its nightly-assessment settings.
 */
export {
  loadEnvFile,
  parseEnvFile,
  writeEnvTemplateIfAbsent,
} from "@regimen/shared";
