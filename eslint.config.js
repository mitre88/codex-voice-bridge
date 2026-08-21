import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/", "dist/", "out/"],
  },
  {
    files: ["src/main.js", "src/lib.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
      },
    },
  },
  {
    files: ["src/preload.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
      },
    },
  },
  {
    files: ["src/renderer.js", "src/renderer-utils.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        RTCPeerConnection: "readonly",
        MediaStream: "readonly",
        Option: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestAnimationFrame: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
  },
  {
    files: ["test/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        Buffer: "readonly",
        structuredClone: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
];
