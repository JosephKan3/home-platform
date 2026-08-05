const preset = require("../../jest.preset.js");

module.exports = {
  ...preset,
  // Source uses NodeNext-style ".js" specifiers on relative imports. ts-jest
  // emits CommonJS, whose resolver needs them stripped back to the .ts file.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
