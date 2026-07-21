import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];
const sourceExtensions = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);

// Raw HTML controls are limited to product-specific interaction boundaries where
// Astryx would change the behavior contract. Exact counts make this a shrinking
// exception list: adding another native control, even in an allowed file, fails CI.
const nativeControlBoundaries = new Map([
  [
    "apps/desktop/src/features/post-production/inspector/background-panel.tsx",
    { count: 10, reason: "background/image selection hit targets and native color input" },
  ],
  [
    "apps/desktop/src/features/editor/simulator-timeline.tsx",
    { count: 5, reason: "timeline scrub and step hit targets" },
  ],
  [
    "apps/desktop/src/features/post-production/inspector/text-appearance-controls.tsx",
    { count: 4, reason: "native color inputs" },
  ],
  [
    "apps/desktop/src/features/editor/story-builder.tsx",
    { count: 3, reason: "invalid numeric draft semantics and native color input" },
  ],
  [
    "apps/desktop/src/features/post-production/preview/preview-player.tsx",
    { count: 3, reason: "authored-preview text editing and resize hit targets" },
  ],
  [
    "apps/desktop/src/features/editor/editor-breadcrumb.tsx",
    { count: 2, reason: "product navigation hit targets" },
  ],
  [
    "apps/desktop/src/features/editor/problems-panel.tsx",
    { count: 2, reason: "diagnostic navigation rows" },
  ],
  [
    "apps/desktop/src/features/editor/scene-list-panel.tsx",
    { count: 2, reason: "scene selection and reorder hit targets" },
  ],
  [
    "apps/desktop/src/features/post-production/inspector/effect-params.tsx",
    { count: 1, reason: "clip selection rows" },
  ],
  [
    "apps/desktop/src/features/post-production/timeline/video-transition-controls.tsx",
    { count: 2, reason: "timeline transition hit targets" },
  ],
  [
    "apps/desktop/src/features/post-production/voiceover-compact/voiceover-compact.tsx",
    { count: 2, reason: "scene and step selection rows" },
  ],
  [
    "apps/desktop/src/features/recorder/video-output/story-color-field.tsx",
    { count: 1, reason: "StoryColorField native color picker" },
  ],
  [
    "apps/desktop/src/features/dashboard/new-project-dialog.tsx",
    { count: 1, reason: "workflow selection card" },
  ],
  [
    "apps/desktop/src/features/editor/preview-panel.tsx",
    { count: 1, reason: "preview target picker" },
  ],
  [
    "apps/desktop/src/features/editor/PreviewPickerButton.tsx",
    { count: 1, reason: "preview picker compound trigger" },
  ],
  [
    "apps/desktop/src/features/post-production/editor-shell.tsx",
    { count: 1, reason: "diagnostic navigation row" },
  ],
  [
    "apps/desktop/src/features/post-production/inspector/preset-picker.tsx",
    { count: 1, reason: "product preset selection card" },
  ],
  [
    "apps/desktop/src/features/post-production/timeline/clip.tsx",
    { count: 1, reason: "draggable timeline clip hit target" },
  ],
  [
    "apps/desktop/src/routes/onboarding.tsx",
    { count: 1, reason: "onboarding goal selection card" },
  ],
]);

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function countNativeControls(source) {
  return stripComments(source).match(/<(?:button|input|select|textarea)(?:\s|>)/g)?.length ?? 0;
}

const forbiddenPaths = [
  "apps/desktop/components.json",
  "apps/desktop/src/components/ui",
  "packages/ui/src/claude-design",
  "packages/ui/src/tokens.css",
];

for (const path of forbiddenPaths) {
  if (existsSync(join(root, path))) failures.push(`${path}: legacy path still exists`);
}

const patterns = [
  [/@base-ui\/react/g, "Base UI import"],
  [/from\s+["']cmdk["']/g, "cmdk import"],
  [/from\s+["']sonner["']/g, "Sonner import"],
  [/class-variance-authority/g, "CVA dependency/import"],
  [/@storycapture\/ui\/(?:claude-design|tokens)/g, "legacy @storycapture/ui subpath"],
  [/(?:@|\/)components\/ui\//g, "local shadcn-style component import"],
  [/\bSc[A-Z][A-Za-z0-9_]*/g, "Sc* primitive"],
  [/--sc-[a-z0-9-]+/gi, "--sc-* token"],
  [/\[data-theme\s*=\s*["']light["']\]/g, "light theme selector"],
  [/storycapture\.theme/g, "application theme persistence"],
];

function scanDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      scanDirectory(absolute);
      continue;
    }
    if (!sourceExtensions.has(extname(entry))) continue;

    const source = readFileSync(absolute, "utf8");
    const sourcePath = relative(root, absolute);
    const lines = source.split("\n");

    if (extname(entry) === ".tsx" && !entry.includes(".test.") && !entry.includes(".spec.")) {
      const actualCount = countNativeControls(source);
      const boundary = nativeControlBoundaries.get(sourcePath);
      if (actualCount > 0 && boundary == null) {
        failures.push(
          `${sourcePath}: ${actualCount} unapproved native control(s); use Astryx or document a product boundary`,
        );
      } else if (boundary != null && actualCount !== boundary.count) {
        failures.push(
          `${sourcePath}: native control boundary changed from ${boundary.count} to ${actualCount} (${boundary.reason})`,
        );
      }
    }

    for (const [pattern, description] of patterns) {
      pattern.lastIndex = 0;
      let match = pattern.exec(source);
      while (match !== null) {
        const line = source.slice(0, match.index).split("\n").length;
        failures.push(
          `${relative(root, absolute)}:${line}: ${description}: ${lines[line - 1]?.trim() ?? match[0]}`,
        );
        if (match[0].length === 0) pattern.lastIndex += 1;
        match = pattern.exec(source);
      }
    }
  }
}

for (const directory of ["apps/desktop/src", "apps/web/src", "packages/ui/src"]) {
  scanDirectory(join(root, directory));
}

for (const [sourcePath, boundary] of nativeControlBoundaries) {
  if (!existsSync(join(root, sourcePath))) {
    failures.push(`${sourcePath}: missing native control boundary (${boundary.reason})`);
  }
}

const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/ui/package.json",
];
const forbiddenDependencies = ["@base-ui/react", "cmdk", "sonner", "class-variance-authority"];

for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const dependency of forbiddenDependencies) {
    if (dependency in dependencies) {
      failures.push(`${manifestPath}: forbidden dependency ${dependency}`);
    }
  }
  if (manifestPath === "packages/ui/package.json" && "tailwind-merge" in dependencies) {
    failures.push(`${manifestPath}: forbidden dependency tailwind-merge`);
  }
}

if (failures.length > 0) {
  console.error(`Astryx rollout guard failed (${failures.length} issue(s)):\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Astryx rollout guard passed: no legacy UI contracts remain.");
