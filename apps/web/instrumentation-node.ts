import { ConfigError, loadWebConfig } from "@epiphany/core";

try {
  loadWebConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
