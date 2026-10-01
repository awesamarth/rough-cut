// Next's template-string emission corrupts a NUL followed by a digit in the
// embedded ProRes WASM payload. Lower templates before Next sees this module;
// esbuild preserves their runtime string bytes. Only this package uses the loader.
// Webpack/Turbopack load this build hook through the CommonJS loader API.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transformSync } = require("esbuild");
module.exports = function proresBuildLoader(source) {
  return transformSync(source, {
    loader: "js",
    supported: { "template-literal": false },
    sourcefile: this.resourcePath,
  }).code;
};
