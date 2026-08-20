import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `comfy_workflows/` is data the weights route reads at request time, not
   * something any import graph points at — so nothing traces it into the
   * serverless bundle and `readdir` finds an empty directory in production.
   * Naming it here is what makes the Model Lab's workflow list work on Vercel
   * as well as on a laptop.
   *
   * Scoped to the one route that reads it: keys are route globs, values are
   * globs resolved from the project root.
   */
  outputFileTracingIncludes: {
    "/api/testing/weights": ["./comfy_workflows/**/*.json"],
  },
};

export default nextConfig;
