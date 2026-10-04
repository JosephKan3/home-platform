/**
 * Shared jest preset. Workspace packages extend this:
 *   module.exports = { ...require("../../jest.preset.js") };
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts", "<rootDir>/src/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  // Turbo runs `test` across all 5 packages in parallel, and each jest process
  // defaults to (CPU count - 1) workers of its own -- on a 4-core GitHub-hosted
  // runner that multiplies out to 15-20 worker processes at once, each loading
  // aws-cdk-lib and ts-jest. This silently exhausted the runner's memory and got
  // the whole job killed mid-test with "the runner has received a shutdown
  // signal" -- no test or compile error, just the OS/runner dying -- three
  // Deploy runs in a row and two Dependabot CI runs. Capping each package's own
  // worker pool keeps the aggregate bounded regardless of how many packages run
  // concurrently.
  maxWorkers: 2,
  // The base tsconfig uses NodeNext, which requires `.js` extensions on relative
  // imports. ts-jest emits CommonJS, whose resolver cannot resolve those
  // specifiers against the on-disk `.ts` files. Strip the extension so jest can.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
