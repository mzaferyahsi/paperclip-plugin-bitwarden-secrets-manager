import { createAuthenticatedBitwardenSdk } from "../.test-build/bitwarden-adapter.mjs";

// Malformed fixture input is rejected locally by the native SDK before any
// authentication request is made. The parent process captures native stderr.
try {
  await createAuthenticatedBitwardenSdk("fixture-bsm-token-7d91a2");
  process.stdout.write("unexpected_success\n");
} catch (error) {
  process.stdout.write(`${error?.code ?? "untyped_error"}\n`);
}
