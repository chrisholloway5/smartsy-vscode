// Bundles two targets:
//   - the extension host (Node, CJS) -> dist/extension.js
//   - the webview UI (browser, IIFE)  -> media/webview.js  (bundles highlight.js)
// `vscode` is provided by the runtime and stays external for the host bundle.
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const shared = { bundle: true, sourcemap: true, minify: !watch, logLevel: "info" };

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "media/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
};

async function main() {
  if (watch) {
    const c1 = await esbuild.context(extension);
    const c2 = await esbuild.context(webview);
    await c1.watch();
    await c2.watch();
    console.log("[smartsy] watching…");
  } else {
    await esbuild.build(extension);
    await esbuild.build(webview);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
