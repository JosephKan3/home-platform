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
  // The base tsconfig uses NodeNext, which requires `.js` extensions on relative
  // imports. ts-jest emits CommonJS, whose resolver cannot resolve those
  // specifiers against the on-disk `.ts` files. Strip the extension so jest can.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
