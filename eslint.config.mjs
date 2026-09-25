import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * Covnant-spelling guard — repo-owned identifiers and copy carry the Covnant
 * brand, never the misspelled brand name.
 *
 * Two scopes:
 *
 * - "sdk" (covnant-sdk/**): zero tolerance. Any occurrence — identifiers,
 *   string/template copy, JSX text, comments — fails, except the preserved
 *   vendored vocabulary below.
 * - "repo" (src/**, e2e/**): identifier-form tokens and string copy fail
 *   unless they belong to the preserved vocabulary locked by the brand-exact
 *   rename policy: the hash-locked engine's own names and module paths, live
 *   column names, persisted JSONB keys, and the Increase idempotency-key
 *   namespace. Standalone prose uses of the English word (contract template
 *   language, UI copy) are exempt outside the package; comments and regex
 *   literals are not scanned in this scope.
 */
const PRESERVED_TOKENS = new Set([
  "covenant-master-sdk", // hash-locked engine module path
  "covenantmastersdk", // hash-locked engine class
  "covenantblockasset", // hash-locked engine asset type
  "covenanttaxengine", // hash-locked engine tax engine
  "covenantauditoragent", // hash-locked engine auditor
  "covenantglobalsocialengine", // hash-locked engine social engine
  "covenantvirtualaccount", // persisted JSONB key on cbt_assets.rights_holders
  "covenantfee", // ledger tier field mirrored from the live column
  "covenant_fee", // live universal_royalty_ledger column
  "covenant_init", // init migration filename
  "covenant-royalty-tracking", // Increase idempotency-key namespace (persisted)
]);

const COVENANT_TOKEN = /covenant[a-z0-9_-]*/gi;

const covnantSpellingRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Repo-owned identifiers and copy carry the Covnant brand spelling.",
    },
    schema: [
      {
        type: "object",
        properties: { scope: { enum: ["sdk", "repo"] } },
        additionalProperties: false,
      },
    ],
    messages: {
      misspelledBrand:
        "'{{token}}' is not the Covnant brand spelling — repo-owned code says 'Covnant'.",
    },
  },
  create(context) {
    const scope = context.options[0]?.scope ?? "repo";
    const sourceCode = context.sourceCode;

    const checkText = (node, text) => {
      if (!text) return;
      for (const match of text.matchAll(COVENANT_TOKEN)) {
        const token = match[0];
        const lower = token.toLowerCase();
        if (lower === "covenant" && scope === "repo") continue;
        if (PRESERVED_TOKENS.has(lower)) continue;
        context.report({
          node,
          messageId: "misspelledBrand",
          data: { token },
        });
      }
    };

    return {
      Identifier(node) {
        checkText(node, node.name);
      },
      PrivateIdentifier(node) {
        checkText(node, node.name);
      },
      Literal(node) {
        if (typeof node.value === "string") checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked);
      },
      JSXText(node) {
        if (scope === "sdk") checkText(node, node.value);
      },
      Program() {
        if (scope !== "sdk") return;
        for (const comment of sourceCode.getAllComments()) {
          checkText(comment, comment.value);
        }
      },
    };
  },
};

const covnantSpellingPlugin = {
  meta: { name: "covnant-spelling-plugin" },
  rules: { "no-covenant-spelling": covnantSpellingRule },
};

const covnantSpelling = (files, scope) => ({
  files,
  plugins: { "covnant-spelling": covnantSpellingPlugin },
  rules: {
    "covnant-spelling/no-covenant-spelling": ["error", { scope }],
  },
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "src/engine/**",
    ],
  },
  covnantSpelling(["covnant-sdk/**/*.ts", "covnant-sdk/**/*.tsx"], "sdk"),
  covnantSpelling(
    ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "e2e/**/*.tsx"],
    "repo",
  ),
  // Byte-identical vendor drop (EmeraldVal PR #41 head c754bb4, integration
  // spec D1 + D2): the Covenant SDK tree, sweep queue, registry, and the
  // 26-tool MCP layer are locked to the drop's own "Covenant" vocabulary and
  // import paths, so the brand guard and unused-import hygiene cannot apply
  // to their bytes — the same reason src/engine/** is fully ignored above.
  // Scope stays minimal: every other rule keeps applying to these files, and
  // repo-owned adaptations of the drop (e.g. src/modules/webhooks,
  // src/modules/ledger/audit.ts) remain fully guarded.
  {
    files: [
      "src/covenant-sdk/**/*.ts",
      "src/mcp/**/*.ts",
      "src/queues/sweepQueue.ts",
      "src/lib/server/covenantRegistry.ts",
    ],
    rules: {
      "covnant-spelling/no-covenant-spelling": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];

export default eslintConfig;