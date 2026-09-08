import js from "@eslint/js";
const common = {
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  URL: "readonly",
  fetch: "readonly",
  AbortSignal: "readonly",
  AbortController: "readonly",
};
export default [
  { ignores: ["node_modules/", "dist/", "out/", "test/", ".cache/", ".artifacts/"] },
  {
    files: ["src/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...common, process: "readonly", Buffer: "readonly" },
    },
  },
  {
    files: ["src/preload.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "readonly" },
    },
  },
  {
    files: [
      "src/renderer.js",
      "src/renderer-utils.js",
      "src/session-controller.js",
      "src/tail-buffer.js",
      "src/visible-renderer.js",
    ],
    languageOptions: {
      globals: {
        ...common,
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        RTCPeerConnection: "readonly",
        Option: "readonly",
        process: "off",
        Buffer: "off",
      },
    },
  },
];
