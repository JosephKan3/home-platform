const preset = require("../../jest.preset.js");

module.exports = {
  ...preset,
  // NodeNext requires .js extensions on relative imports; jest resolves against
  // the on-disk .ts sources, so the extension has to be mapped away.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
};
