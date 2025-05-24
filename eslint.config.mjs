import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

// Define custom globals
const customGlobals = {
  logger: "readonly",
  process: "readonly" // Adding process explicitly in case you need it
};

export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"] },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { 
    files: ["**/*.{js,mjs,cjs}"], 
    languageOptions: { 
      // Merge browser globals with our custom globals
      globals: {
        ...globals.browser,
        ...globals.node,  // Add node globals which includes process
        ...customGlobals
      } 
    }
  },
]);

