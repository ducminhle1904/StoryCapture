import type { Command, Meta, Scene, SelectorOrText, Story } from "@/ipc/parse";
import type { PickLocator } from "@/ipc/picker";

export type EditableCommand = Command & { step_id?: string | null };
export type EditableStory = Omit<Story, "scenes"> & {
  scenes: Array<Omit<Scene, "commands"> & { commands: EditableCommand[] }>;
};

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createStepId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random()}`;
}

function formatTarget(target: SelectorOrText): string {
  switch (target.kind) {
    case "selector":
      return `selector ${quote(target.value)}`;
    case "test_id":
      return `testid ${quote(target.value)}`;
    case "aria":
      return `aria ${quote(target.value)}`;
    case "role":
      return `${target.value.role} ${quote(target.value.name)}`;
    case "label":
      return `field ${quote(target.value)}`;
    case "text_exact":
      return `text ${quote(target.value)}`;
    case "text":
      return quote(target.value);
  }
}

function formatMeta(meta: Meta): string[] {
  const lines: string[] = [];
  if (!meta.app && !meta.viewport && !meta.theme && meta.speed == null) return lines;
  lines.push("  meta {");
  if (meta.app) lines.push(`    app: ${quote(meta.app)}`);
  if (meta.viewport) lines.push(`    viewport: ${meta.viewport.width}x${meta.viewport.height}`);
  if (meta.theme) lines.push(`    theme: ${meta.theme}`);
  if (meta.speed != null) lines.push(`    speed: ${meta.speed}`);
  lines.push("  }");
  return lines;
}

function formatCommand(command: EditableCommand): string {
  let line: string;
  switch (command.verb) {
    case "navigate":
      line = `navigate ${quote(command.url)}`;
      break;
    case "click":
      line = `click ${formatTarget(command.target)}`;
      break;
    case "type":
      line = `type ${formatTarget(command.target)} ${quote(command.text)}`;
      break;
    case "scroll":
      line = `scroll ${command.direction}${command.amount == null ? "" : ` ${command.amount}`}`;
      break;
    case "hover":
      line = `hover ${formatTarget(command.target)}`;
      break;
    case "drag":
      line = `drag ${formatTarget(command.from)} to ${formatTarget(command.to)}`;
      break;
    case "select":
      line = `select ${formatTarget(command.target)} ${quote(command.value)}`;
      break;
    case "upload":
      line = `upload ${formatTarget(command.target)} ${quote(command.path)}`;
      break;
    case "wait":
      line = `wait ${command.duration_ms}ms`;
      break;
    case "wait-for":
      line = `wait-for ${formatTarget(command.target)}${
        command.timeout_ms == null ? "" : ` timeout ${command.timeout_ms}ms`
      }`;
      break;
    case "assert":
      line = `assert ${formatTarget(command.target)}`;
      break;
    case "screenshot":
      line = `screenshot ${quote(command.name)}`;
      break;
    case "pause":
      line = "pause";
      break;
  }
  return command.step_id ? `${line}  # @id=${command.step_id}` : line;
}

export function formatEditableStory(story: EditableStory): string {
  const lines: string[] = [story.name ? `story ${quote(story.name)} {` : "story {"];
  lines.push(...formatMeta(story.meta));
  for (const scene of story.scenes) {
    lines.push(`  scene ${quote(scene.name)} {`);
    for (const command of scene.commands) {
      lines.push(`    ${formatCommand(command)}`);
    }
    lines.push("  }");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function cloneStoryWithStepId(
  story: Story,
  sceneIndex: number,
  commandIndex: number,
): { story: EditableStory; stepId: string } {
  const cloned = structuredClone(story) as EditableStory;
  const command = cloned.scenes[sceneIndex]?.commands[commandIndex];
  const stepId = command?.step_id ?? createStepId();
  if (command) command.step_id = stepId;
  return { story: cloned, stepId };
}

export function ensureAllStepIds(story: Story): { story: EditableStory; changed: boolean } {
  const cloned = structuredClone(story) as EditableStory;
  let changed = false;
  for (const scene of cloned.scenes) {
    for (const command of scene.commands) {
      if (!command.step_id) {
        command.step_id = createStepId();
        changed = true;
      }
    }
  }
  return { story: cloned, changed };
}

export function patchCommand(
  story: Story,
  sceneIndex: number,
  commandIndex: number,
  patch: Partial<EditableCommand>,
): EditableStory {
  const cloned = structuredClone(story) as EditableStory;
  const command = cloned.scenes[sceneIndex]?.commands[commandIndex];
  if (command) Object.assign(command, patch);
  return cloned;
}

export function patchSceneName(story: Story, sceneIndex: number, name: string): EditableStory {
  const cloned = structuredClone(story) as EditableStory;
  const scene = cloned.scenes[sceneIndex];
  if (scene) scene.name = name;
  return cloned;
}

export function targetLabel(target: SelectorOrText): string {
  switch (target.kind) {
    case "role":
      return `${target.value.role} "${target.value.name}"`;
    default:
      return `${target.kind.replace("_", " ")} "${target.value}"`;
  }
}

export function updateCommandTarget(
  command: EditableCommand,
  value: string,
): Partial<EditableCommand> {
  if (!("target" in command)) return {};
  const target = command.target;
  if (target.kind === "role") {
    return {
      target: { ...target, value: { ...target.value, name: value } },
    } as Partial<EditableCommand>;
  }
  return { target: { ...target, value } } as Partial<EditableCommand>;
}

export function selectorFromPickLocator(locator: PickLocator): SelectorOrText {
  switch (locator.kind) {
    case "testid":
      return { kind: "test_id", value: stringLocatorValue(locator) };
    case "role":
      if (
        locator.value &&
        typeof locator.value === "object" &&
        "role" in locator.value &&
        "name" in locator.value
      ) {
        return { kind: "role", value: { role: locator.value.role, name: locator.value.name } };
      }
      return { kind: "text", value: "" };
    case "label":
      return { kind: "label", value: stringLocatorValue(locator) };
    case "text_exact":
      return { kind: "text_exact", value: stringLocatorValue(locator) };
    case "selector":
      return { kind: "selector", value: stringLocatorValue(locator) };
    case "aria":
      return { kind: "aria", value: stringLocatorValue(locator) };
    case "text":
      return { kind: "text", value: stringLocatorValue(locator) };
    default:
      return { kind: "selector", value: stringLocatorValue(locator) };
  }
}

function stringLocatorValue(locator: PickLocator): string {
  return typeof locator.value === "string" ? locator.value : locator.value.name;
}

export function updateCommandTargetFromPick(
  command: EditableCommand,
  locator: PickLocator,
): Partial<EditableCommand> {
  const target = selectorFromPickLocator(locator);
  switch (command.verb) {
    case "click":
    case "hover":
    case "assert":
    case "wait-for":
    case "type":
    case "select":
    case "upload":
      return { target } as Partial<EditableCommand>;
    case "drag":
      return { from: target } as Partial<EditableCommand>;
    default:
      return {};
  }
}

export function commandSupportsPick(command: EditableCommand): boolean {
  return (
    command.verb === "click" ||
    command.verb === "hover" ||
    command.verb === "assert" ||
    command.verb === "wait-for" ||
    command.verb === "type" ||
    command.verb === "select" ||
    command.verb === "upload" ||
    command.verb === "drag"
  );
}

export function commandSupportsVisualFocus(command: EditableCommand): boolean {
  return commandSupportsPick(command);
}
