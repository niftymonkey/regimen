import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // prototypes/ holds throwaway probes: never committed (.gitignore), never linted. Remove this entry when the prototype is deleted.
  { ignores: ["**/node_modules/", "**/out/", "**/prototypes/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
