export const SCHEMA_VERSION = "1";

export const ENUMS = {
  appearance: ["light", "dark"],
  configuration: ["Debug", "Release"],
  container: ["app", "data"],
  privacyAction: ["grant", "revoke", "reset"],
  privacyService: [
    "contacts", "contacts-limited", "calendar", "location", "location-always",
    "photos", "photos-add", "media-library", "microphone", "motion",
    "reminders", "siri", "all",
  ],
  button: ["home", "lock", "siri", "side_button", "apple_pay"],
} as const;

interface Arg {
  name: string;
  required?: boolean;
  variadic?: boolean;
  enum?: readonly string[];
  desc: string;
}
interface Flag {
  name: string;
  type: "string" | "bool";
  metavar?: string;
  enum?: readonly string[];
  default?: string;
  repeatable?: boolean;
  desc: string;
}
interface Sub {
  name: string;
  aliases?: string[];
  args?: Arg[];
  summary: string;
}
interface Command {
  name: string;
  group: string;
  summary: string;
  aliases?: string[];
  usage?: string;
  args?: Arg[];
  flags?: Flag[];
  subcommands?: Sub[];
  notes?: string;
}

export const GLOBALS: Flag[] = [
  { name: "device", type: "string", metavar: "name|udid|booted", default: "booted", desc: "target simulator by name or UDID (env SIM_DEVICE; --udid/IDB_UDID also accepted). With multiple booted sims you must pass --device." },
  { name: "companion", type: "string", metavar: "host:port|unix:/sock", desc: "pin a companion endpoint, bypassing autoresolve (env IDB_COMPANION)" },
  { name: "verbose", type: "bool", desc: "log companion resolution to stderr (-v)" },
];

export const COMMANDS: Command[] = [
  {
    name: "devices", group: "DEVICE", summary: "list simulators / manage device names",
    aliases: ["list-devices"],
    usage: "devices [rename <device> <new_name>]",
    subcommands: [
      { name: "list", summary: "list all simulators (default when no subcommand)" },
      { name: "rename", args: [
        { name: "device", required: true, desc: "name, UDID, or booted" },
        { name: "new_name", required: true, desc: "new device name, usable with --device" },
      ], summary: "rename a simulator" },
    ],
  },
  { name: "list-apps", group: "DEVICE", summary: "list installed apps" },
  {
    name: "uninstall", group: "DEVICE", summary: "remove an installed app",
    args: [{ name: "bundle_id", required: true, desc: "app to remove" }],
  },
  {
    name: "appearance", group: "DEVICE", summary: "set UI appearance",
    args: [{ name: "mode", required: true, enum: ENUMS.appearance, desc: "light or dark" }],
  },
  { name: "clear-keychain", group: "DEVICE", summary: "reset the simulator keychain" },

  {
    name: "run", group: "APP", summary: "build -> install -> terminate prior -> launch -> wait -> capture logs",
    args: [
      { name: "bundle_id", required: true, desc: "app to launch" },
      { name: "args", variadic: true, desc: "extra launch arguments, appended after scheme args" },
    ],
    flags: [
      { name: "workspace", type: "string", metavar: "path", desc: "Xcode workspace (auto-detected in CWD)" },
      { name: "project", type: "string", metavar: "path", desc: "Xcode project (auto-detected in CWD)" },
      { name: "scheme", type: "string", metavar: "name", desc: "build scheme; also reads LaunchAction env vars + args from the matching .xcscheme (auto-detected if only one)" },
      { name: "configuration", type: "string", enum: ENUMS.configuration, default: "Debug", desc: "build configuration" },
      { name: "app", type: "string", metavar: "path", desc: "launch a prebuilt .app instead of building" },
      { name: "env", type: "string", metavar: "KEY=VAL", repeatable: true, desc: "app env var, overrides scheme value" },
    ],
    notes: "Device logs stream to ~/.sim-cli/logs/<udid>.log (verbose ndjson, truncated each run). See `logs` / `config`.",
  },
  {
    name: "openurl", group: "APP", summary: "open a URL / deep link",
    args: [{ name: "url", required: true, desc: "URL or app deep link" }],
  },
  {
    name: "push", group: "APP", summary: "send a simulated APNs push",
    args: [
      { name: "bundle_id", desc: "target app (may instead live in the payload's \"Simulator Target Bundle\" key)" },
      { name: "payload.json", required: true, desc: "APNs payload file" },
    ],
  },

  {
    name: "file", group: "FILES", summary: "read/write the app container",
    flags: [
      { name: "container", type: "string", enum: ENUMS.container, default: "data", desc: "container kind for all file ops" },
      { name: "dest", type: "string", metavar: "dir", desc: "(file pull only) destination dir, alternative to positional (default CWD)" },
    ],
    subcommands: [
      { name: "list", aliases: ["ls"], args: [{ name: "bundle_id", required: true, desc: "app" }, { name: "path", desc: "container path (default root)" }], summary: "list entries in the app container at <path>" },
      { name: "pull", args: [{ name: "bundle_id", required: true, desc: "app" }, { name: "src", required: true, desc: "path relative to container root" }, { name: "dest", desc: "local destination (default CWD)" }], summary: "copy a file/dir out of the container" },
      { name: "push", args: [{ name: "bundle_id", required: true, desc: "app" }, { name: "local", required: true, desc: "local source" }, { name: "dest", required: true, desc: "container destination" }], summary: "copy a local file/dir into the container" },
      { name: "delete", aliases: ["rm"], args: [{ name: "bundle_id", required: true, desc: "app" }, { name: "path", required: true, desc: "container path" }], summary: "delete a file/dir from the container" },
      { name: "mkdir", args: [{ name: "bundle_id", required: true, desc: "app" }, { name: "path", required: true, desc: "container path" }], summary: "create a directory (mkdir -p) in the container" },
      { name: "mv", args: [{ name: "bundle_id", required: true, desc: "app" }, { name: "src", required: true, desc: "container path" }, { name: "dest", required: true, desc: "container path" }], summary: "rename/move within the container" },
    ],
  },

  {
    name: "privacy", group: "PERMISSIONS", summary: "grant/revoke/reset a privacy service for the app",
    args: [
      { name: "action", required: true, enum: ENUMS.privacyAction, desc: "grant, revoke, or reset" },
      { name: "service", required: true, enum: ENUMS.privacyService, desc: "privacy service to change" },
      { name: "bundle_id", desc: "app; required for grant/revoke, optional for reset (resets globally)" },
    ],
  },

  { name: "config", group: "STATE", summary: "dump ~/.sim-cli: companion registry + captured log files" },
  {
    name: "logs", group: "STATE", summary: "list captured log files from prior runs",
    flags: [{ name: "device", type: "string", metavar: "name|udid", desc: "only this sim's capture" }],
    notes: "Lists path, size, last-modified, and whether capture is still live.",
  },
  {
    name: "record-video", group: "STATE", summary: "record the display to a .mov",
    flags: [{ name: "out", type: "string", metavar: "file.mov", desc: "(start only) output path (default tmp file)" }],
    subcommands: [
      { name: "start", summary: "start recording in the background" },
      { name: "stop", summary: "SIGINT the recorder; simctl finalizes the file" },
    ],
  },
  {
    name: "status-bar", group: "STATE", summary: "set or clear status-bar overrides",
    flags: [
      { name: "time", type: "string", desc: "(override) clock value" },
      { name: "dataNetwork", type: "string", desc: "(override) data network" },
      { name: "wifiMode", type: "string", desc: "(override) wifi mode" },
      { name: "wifiBars", type: "string", desc: "(override) wifi bars" },
      { name: "cellularMode", type: "string", desc: "(override) cellular mode" },
      { name: "cellularBars", type: "string", desc: "(override) cellular bars" },
      { name: "operatorName", type: "string", desc: "(override) carrier name" },
      { name: "batteryState", type: "string", desc: "(override) battery state" },
      { name: "batteryLevel", type: "string", desc: "(override) battery level" },
    ],
    subcommands: [
      { name: "override", summary: "set status-bar overrides (at least one flag required)" },
      { name: "clear", summary: "clear all status-bar overrides" },
    ],
  },

  {
    name: "crash", group: "DIAGNOSTICS", summary: "inspect crash reports in ~/Library/Logs/DiagnosticReports",
    flags: [{ name: "bundle", type: "string", metavar: "bundle_id", desc: "(list only) filter by bundle ID" }],
    subcommands: [
      { name: "list", summary: "list crash reports" },
      { name: "show", args: [{ name: "name", required: true, desc: "report name" }], summary: "print the full crash report to stdout" },
      { name: "delete", args: [{ name: "name", required: true, desc: "report name" }], summary: "delete a crash report" },
    ],
  },

  {
    name: "screenshot", group: "OBSERVE", summary: "capture screen as PNG",
    flags: [
      { name: "out", type: "string", metavar: "file.png", desc: "output path (default tmp file)" },
      { name: "base64", type: "bool", desc: "also embed base64 in JSON" },
    ],
  },
  {
    name: "describe", group: "OBSERVE", summary: "return accessibility tree",
    flags: [
      { name: "point", type: "string", metavar: "x,y", desc: "tree at a single point" },
      { name: "screenshot", type: "bool", desc: "embed base64 PNG alongside" },
    ],
  },

  {
    name: "tap", group: "INTERACT", summary: "tap at coordinates or at a matched AX element",
    usage: "tap <x> <y> | tap --label|--role|--text|--id <s>",
    args: [{ name: "x", desc: "x coordinate" }, { name: "y", desc: "y coordinate" }],
    flags: [
      { name: "label", type: "string", desc: "match AXLabel (substring, case-insensitive)" },
      { name: "role", type: "string", desc: "match AXRole" },
      { name: "text", type: "string", desc: "match label or value" },
      { name: "id", type: "string", desc: "match accessibilityIdentifier (AXUniqueId), exact" },
      { name: "wait", type: "string", metavar: "ms", desc: "poll up to N ms for the matcher to hit" },
      { name: "duration", type: "string", metavar: "s", desc: "hold duration" },
    ],
    notes: "Actionable roles (AXButton, AXCell, …) win over AXStaticText when a matcher hits several elements.",
  },
  {
    name: "swipe", group: "INTERACT", summary: "swipe between points",
    args: [
      { name: "x1", required: true, desc: "start x" }, { name: "y1", required: true, desc: "start y" },
      { name: "x2", required: true, desc: "end x" }, { name: "y2", required: true, desc: "end y" },
    ],
    flags: [
      { name: "duration", type: "string", metavar: "s", desc: "gesture duration" },
      { name: "delta", type: "string", metavar: "n", desc: "gesture granularity" },
    ],
  },
  {
    name: "type", group: "INTERACT", summary: "send keystrokes to the focused field",
    usage: 'type "<string>"',
    args: [{ name: "string", required: true, variadic: true, desc: "text to type" }],
  },
  {
    name: "fill", group: "INTERACT", summary: "tap a text field, wait for focus, then type",
    usage: 'fill --label|--role|--text|--id <s> "<value>"',
    args: [{ name: "value", required: true, variadic: true, desc: "text to type" }],
    flags: [
      { name: "label", type: "string", desc: "match AXLabel" },
      { name: "role", type: "string", desc: "match AXRole" },
      { name: "text", type: "string", desc: "match label or value" },
      { name: "id", type: "string", desc: "match accessibilityIdentifier" },
      { name: "wait", type: "string", metavar: "ms", desc: "poll up to N ms for the matcher to hit" },
      { name: "settle", type: "string", metavar: "ms", default: "200", desc: "focus-animation settle" },
    ],
    notes: "Requires one of --label/--role/--text/--id. After typing, re-reads the element and reports {verified, value}; if nothing landed (slow focus animation), waits max(4*settle, 1s) and retypes once, reporting {retried: true}. verified:false with an unchanged value means the text did not stick.",
  },
  {
    name: "press", group: "INTERACT", summary: "press a hardware button",
    args: [{ name: "button", required: true, enum: ENUMS.button, desc: "hardware button" }],
    flags: [{ name: "duration", type: "string", metavar: "s", desc: "hold duration" }],
  },
];

function inlineEnum(values: readonly string[]): boolean {
  return values.length <= 5;
}

function renderArg(a: Arg): string {
  const inner = a.enum && inlineEnum(a.enum) ? a.enum.join("|") : a.name;
  if (a.variadic) return `[${inner}...]`;
  return a.required ? `<${inner}>` : `[${inner}]`;
}

function flagMetavar(f: Flag): string {
  if (f.type === "bool") return "";
  if (f.enum) return ` <${f.enum.join("|")}>`;
  return ` <${f.metavar ?? "value"}>`;
}

export function usageOf(c: Command): string {
  if (c.usage) return c.usage;
  if (c.subcommands) return `${c.name} <${c.subcommands.map((s) => s.name).join("|")}> ...`;
  const args = c.args?.map(renderArg).join(" ") ?? "";
  return args ? `${c.name} ${args}` : c.name;
}

const FOOTER = `Run \`sim-cli help <command>\` (or \`sim-cli <command> --help\`) for details on a command.
\`sim-cli agent-context\` returns the full command schema as machine-readable JSON.
All commands write JSON to stdout on success and {"error": "..."} to stderr on failure.`;

function renderFlagLine(f: Flag, indent: string): string {
  const left = `${indent}--${f.name}${flagMetavar(f)}`;
  const suffix = [f.default ? `(${f.default})` : "", f.repeatable ? "(repeatable)" : ""].filter(Boolean).join(" ");
  const right = suffix ? `${f.desc}  ${suffix}` : f.desc;
  return left.length > 36 ? `${left}\n${" ".repeat(38)}${right}` : `${left.padEnd(38)}${right}`;
}

export function overview(): string {
  const lines = [
    "sim-cli — agent-friendly iOS simulator CLI",
    "",
    "USAGE",
    "  sim-cli [globals] <command> [args] [flags]",
    "",
    "GLOBALS",
    ...GLOBALS.map((f) => renderFlagLine(f, "  ")),
  ];
  const COL = 38;
  let group = "";
  for (const c of COMMANDS) {
    if (c.group !== group) {
      group = c.group;
      lines.push("", group);
    }
    const u = usageOf(c);
    if (u.length > COL - 2) {
      lines.push(`  ${u}`, `${" ".repeat(COL + 2)}${c.summary}`);
    } else {
      lines.push(`  ${u.padEnd(COL)}${c.summary}`);
    }
  }
  lines.push("", FOOTER, "");
  return lines.join("\n");
}

export function commandHelp(name: string): string | undefined {
  const c = resolveCommand(name);
  if (!c) return undefined;
  const lines = [`USAGE\n  sim-cli ${usageOf(c)}`, "", c.summary];
  if (c.subcommands) {
    lines.push("", "SUBCOMMANDS");
    for (const s of c.subcommands) {
      const alias = s.aliases?.length ? ` (alias: ${s.aliases.join(", ")})` : "";
      const sub = `${s.name}${s.args?.length ? " " + s.args.map(renderArg).join(" ") : ""}`;
      lines.push(`  ${sub.padEnd(36)}${s.summary}${alias}`);
    }
  }
  if (c.flags?.length) {
    lines.push("", "FLAGS", ...c.flags.map((f) => renderFlagLine(f, "  ")));
  }
  if (c.notes) lines.push("", c.notes);
  lines.push("");
  return lines.join("\n");
}

export function resolveCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

export function resolveSubcommand(c: Command, name: string): Sub | undefined {
  return c.subcommands?.find((s) => s.name === name || s.aliases?.includes(name));
}

export function enumError(label: string, got: string, valid: readonly string[]): string {
  return `${label} must be one of: ${valid.join(", ")} (got: "${got}")`;
}

export function agentContext() {
  return {
    schema_version: SCHEMA_VERSION,
    cli: "sim-cli",
    description: "agent-friendly iOS simulator CLI; JSON to stdout on success, {\"error\":...} to stderr on failure",
    globals: GLOBALS.map(flagContext),
    commands: Object.fromEntries(COMMANDS.map((c) => [c.name, commandContext(c)])),
  };
}

function flagContext(f: Flag) {
  return {
    name: f.name, type: f.enum ? "enum" : f.type,
    ...(f.enum ? { values: f.enum } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
    ...(f.repeatable ? { repeatable: true } : {}),
    description: f.desc,
  };
}
function argContext(a: Arg) {
  return {
    name: a.name, required: !!a.required,
    ...(a.variadic ? { variadic: true } : {}),
    ...(a.enum ? { type: "enum", values: a.enum } : {}),
    description: a.desc,
  };
}
function commandContext(c: Command) {
  return {
    group: c.group, summary: c.summary,
    ...(c.aliases ? { aliases: c.aliases } : {}),
    usage: usageOf(c),
    ...(c.args ? { args: c.args.map(argContext) } : {}),
    ...(c.flags ? { flags: c.flags.map(flagContext) } : {}),
    ...(c.subcommands ? {
      subcommands: Object.fromEntries(c.subcommands.map((s) => [s.name, {
        summary: s.summary,
        ...(s.aliases ? { aliases: s.aliases } : {}),
        ...(s.args ? { args: s.args.map(argContext) } : {}),
      }])),
    } : {}),
    ...(c.notes ? { notes: c.notes } : {}),
  };
}
