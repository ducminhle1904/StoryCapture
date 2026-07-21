import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, "../../..");
const allowlistPath = path.join(repoRoot, "packages/ui/design-literal-allowlist.json");
const updateAllowlist = process.argv.includes("--update-allowlist");
const allowlist = updateAllowlist ? {} : JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
const sourceRoots = ["apps/desktop/src", "apps/web/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".css"]);
const deprecatedImports = [
  "@/components/ui/accordion",
  "@/components/ui/button",
  "@/components/ui/radio-group",
  "@/components/ui/select",
  "@/components/ui/slider",
  "@/components/ui/toggle-group",
];
const discoveredLiterals = {};
const errors = [];

function normalizeLiteral(literal) {
  return literal.replace(/\s+/g, " ").trim();
}

function extractColorLiterals(content) {
  const literals = content.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  const functionPattern = /\b(?:rgba?|hsla?|oklch)\(/g;
  let match;

  while ((match = functionPattern.exec(content)) !== null) {
    const start = match.index;
    let depth = 0;
    let end = content.indexOf("(", start);

    for (; end < content.length; end += 1) {
      if (content[end] === "(") depth += 1;
      if (content[end] !== ")") continue;
      depth -= 1;
      if (depth === 0) break;
    }

    if (depth === 0) {
      literals.push(content.slice(start, end + 1));
      functionPattern.lastIndex = end + 1;
    }
  }

  return literals.map(normalizeLiteral);
}

function extractDesignLiterals(content) {
  const literals = extractColorLiterals(content);
  const dimensions = content.match(/-?(?:\d*\.)?\d+(?:px|rem|em|fr)\b/g) ?? [];
  const sizedPropPattern =
    /\b(?:size|width|height|minWidth|maxWidth|minHeight|maxHeight)=\{-?(?:\d*\.)?\d+\}/g;

  literals.push(...dimensions.map(normalizeLiteral));
  literals.push(
    ...(content.match(sizedPropPattern) ?? []).map(
      (literal) => `prop:${literal.replace(/\s+/g, "")}`,
    ),
  );
  return literals;
}

function countLiterals(literals) {
  const counts = new Map();
  for (const literal of literals) counts.set(literal, (counts.get(literal) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function checkLiterals(relativePath, actual) {
  const allowed = allowlist[relativePath] ?? {};
  if (typeof allowed !== "object" || Array.isArray(allowed)) {
    errors.push(`${relativePath}: invalid design-literal allowlist entry`);
    return;
  }

  for (const [literal, actualCount] of Object.entries(actual)) {
    const allowedCount = allowed[literal] ?? 0;
    if (actualCount > allowedCount) {
      errors.push(
        `${relativePath}: unapproved design literal ${JSON.stringify(literal)} ` +
          `(${actualCount} found, ${allowedCount} allowed)`,
      );
    }
  }
}

function visit(relativeDirectory) {
  const absoluteDirectory = path.join(repoRoot, ...relativeDirectory.split("/"));
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.name === "generated") continue;
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      visit(relativePath);
      continue;
    }
    if (!sourceExtensions.has(path.extname(entry.name))) continue;

    const content = fs.readFileSync(absolutePath, "utf8");
    const literals = countLiterals(extractDesignLiterals(content));
    if (Object.keys(literals).length > 0) discoveredLiterals[relativePath] = literals;
    if (!updateAllowlist) checkLiterals(relativePath, literals);

    for (const deprecatedImport of deprecatedImports) {
      if (content.includes(`${deprecatedImport}\"`) || content.includes(`${deprecatedImport}'`)) {
        errors.push(`${relativePath}: deprecated local primitive import ${deprecatedImport}`);
      }
    }
  }
}

for (const sourceRoot of sourceRoots) visit(sourceRoot);

const uiSource = path.join(repoRoot, "packages/ui/src");
function checkSharedUi(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "catalog") checkSharedUi(absolutePath);
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    const content = fs.readFileSync(absolutePath, "utf8");
    if (extractColorLiterals(content).length > 0) {
      errors.push(`${path.relative(repoRoot, absolutePath)}: use canonical CSS tokens`);
    }
  }
}
checkSharedUi(uiSource);

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

if (updateAllowlist) {
  const sortedAllowlist = Object.fromEntries(
    Object.entries(discoveredLiterals).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.writeFileSync(allowlistPath, `${JSON.stringify(sortedAllowlist, null, 2)}\n`);
  console.log("Design-literal allowlist updated.");
} else {
  console.log("Design-system boundary checks passed.");
}
