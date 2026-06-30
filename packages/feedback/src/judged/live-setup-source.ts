/**
 * The live SetupSource adapter: the harness-neutral capture edge for the
 * engineer's setup. This is the ONLY module that knows harness-specific file
 * names and directory locations; everything it returns is the neutral
 * {@link EngineerSetup}, so no file name and no harness or model identity ever
 * leaves this file.
 *
 * Setup is discovered two ways, both over a REGISTERED set that lives only in
 * this file's private constants:
 * - Stated conventions: a roster of agent-instruction file names looked up at
 *   the project root (scope "project") and at the engineer's home (scope
 *   "global"). Each match becomes a ConventionSource carrying the file's text.
 * - Established practices: a set of skill/practice directories under home. Each
 *   skill (a directory with a SKILL.md, or a plain file) normalizes to its name
 *   and one-line summary.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type {
  ConventionSource,
  EngineerSetup,
  EstablishedPractice,
  SetupSource,
} from "./setup.ts";

/**
 * The agent-instruction file names that count as the engineer's stated
 * conventions. This roster is the only harness-aware convention datum, kept here
 * at the edge: CLAUDE.md, AGENTS.md, and GEMINI.md are all just "stated
 * conventions"; a future harness's file joins this same list. Project and global
 * scopes use the same roster.
 */
const DEFAULT_CONVENTION_ROSTER: ReadonlyArray<string> = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
];

/** The SKILL.md file a practice directory carries when it is a skill folder. */
const SKILL_MANIFEST = "SKILL.md";

/**
 * Convention text is truncated to this many characters so a very large
 * convention file cannot bloat the judge prompt. Read synchronously, then sliced
 * (these files are small in practice; the cap is a safety bound, not a budget).
 */
const CONVENTION_TEXT_CAP = 8192;

/** A practice summary is truncated to this many characters: it is one line. */
const PRACTICE_SUMMARY_CAP = 200;

/**
 * The skill/practice directories that count as the engineer's established
 * practices, resolved relative to home. This is the only harness-aware practice
 * datum, kept here at the edge: a harness-local skills folder and a
 * harness-agnostic skills location are both just "established practices".
 */
function defaultPracticeDirs(home: string): ReadonlyArray<string> {
  return [join(home, ".claude", "skills"), join(home, ".agents", "skills")];
}

/** Overrides for the live source, all defaulting to the real registered values. */
export interface LiveSetupSourceConfig {
  /** The engineer's home directory; defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** The agent-instruction file roster; defaults to the registered names. */
  readonly conventionRoster?: ReadonlyArray<string>;
  /** The practice/skill directories; defaults to the registered home locations. */
  readonly practiceDirs?: ReadonlyArray<string>;
}

/**
 * Build a live SetupSource. The home root, the convention roster, and the
 * practice directories are injectable so a test can point them at a fixture and
 * never touch the developer's real home; all default to the real registered
 * values.
 */
export function createLiveSetupSource(
  config: LiveSetupSourceConfig = {},
): SetupSource {
  const home = config.homeDir ?? homedir();
  const conventionRoster = config.conventionRoster ?? DEFAULT_CONVENTION_ROSTER;
  const practiceDirs = config.practiceDirs ?? defaultPracticeDirs(home);

  return {
    /**
     * Discover and normalize the engineer's setup. v1 reads the LIVE filesystem
     * and returns it for every `asOf`: approximating the setup in force at the
     * conversation's time by today's setup is a bounded, documented staleness. A
     * conversation-time snapshot reader is the reserved future implementation
     * behind this same port, so `asOf` is accepted now though it does not yet
     * change the result. Returns undefined when nothing is discoverable (no
     * convention file found AND no practice).
     */
    resolve(input): EngineerSetup | undefined {
      const projectRoot = input.cwd ?? process.cwd();
      const conventions: ConventionSource[] = [
        ...readConventions(projectRoot, "project", conventionRoster),
        ...readConventions(home, "global", conventionRoster),
      ];
      const practices: EstablishedPractice[] = readPractices(practiceDirs);
      if (conventions.length === 0 && practices.length === 0) return undefined;
      return { conventions, practices };
    },
  };
}

/**
 * Read each roster file that exists under `dir`, returning one size-bounded
 * ConventionSource per file tagged with `scope`. A roster file that does not
 * exist (or cannot be read) is skipped silently. The file name never leaves this
 * function: only its text and the generic scope are returned.
 */
function readConventions(
  dir: string,
  scope: ConventionSource["scope"],
  roster: ReadonlyArray<string>,
): ConventionSource[] {
  const out: ConventionSource[] = [];
  for (const fileName of roster) {
    const text = tryReadText(join(dir, fileName));
    if (text === undefined) continue;
    out.push({ scope, text: text.slice(0, CONVENTION_TEXT_CAP) });
  }
  return out;
}

/**
 * Read every registered practice directory, normalizing each skill to a name and
 * a one-line summary. A missing or unreadable registered directory is skipped
 * silently (not an error), per the robustness requirement.
 */
function readPractices(dirs: ReadonlyArray<string>): EstablishedPractice[] {
  const out: EstablishedPractice[] = [];
  for (const dir of dirs) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const practice = describePractice(dir, entry);
      if (practice !== undefined) out.push(practice);
    }
  }
  return out;
}

/**
 * Normalize one directory entry to a practice, or undefined when it is not a
 * recognized one. A directory is a practice only if it carries a SKILL.md
 * (name/summary from that manifest's frontmatter, else its directory name and
 * the manifest's leading words); a plain file is a practice named by its file
 * name with the file's leading words as the summary.
 */
function describePractice(
  dir: string,
  entry: import("node:fs").Dirent,
): EstablishedPractice | undefined {
  if (entry.isDirectory()) {
    const manifest = tryReadText(join(dir, entry.name, SKILL_MANIFEST));
    if (manifest === undefined) return undefined;
    return describeFromManifest(manifest, entry.name);
  }
  if (entry.isFile()) {
    const text = tryReadText(join(dir, entry.name));
    if (text === undefined) return undefined;
    const name = basename(entry.name, extname(entry.name));
    return describeFromManifest(text, name);
  }
  return undefined;
}

/**
 * Derive a practice's name and summary from a manifest's content: the
 * frontmatter `name:` and `description:` when present, else the fallback name and
 * the manifest's leading words. The summary is capped to one line's worth.
 */
function describeFromManifest(
  content: string,
  fallbackName: string,
): EstablishedPractice {
  const { fields, body } = parseFrontmatter(content);
  const name = fields.name ?? fallbackName;
  const summary = fields.description ?? leadingWords(body);
  return { name, summary: summary.slice(0, PRACTICE_SUMMARY_CAP) };
}

/**
 * Read a file as utf8, returning undefined when it does not exist or cannot be
 * read. The single guarded read used for conventions and practice manifests.
 */
function tryReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A minimal YAML-frontmatter scan: when the content opens with a `---` fence, the
 * single-line `key: value` pairs up to the closing `---` are collected (only
 * `name` and `description` are consumed downstream) and surrounding quotes are
 * stripped. No YAML dependency: frontmatter here is flat single-line values. The
 * body is the content after the closing fence (or the whole content when there
 * is no frontmatter).
 */
function parseFrontmatter(content: string): {
  fields: Record<string, string>;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  let bodyStart = lines.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "---") {
      bodyStart = i + 1;
      break;
    }
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) {
      fields[key] = unquote(value.trim());
    }
  }
  return { fields, body: lines.slice(bodyStart).join("\n") };
}

/** Strip a single pair of matching surrounding double or single quotes. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * The leading words of a manifest body: the first non-empty prose line, used as
 * a practice summary when no frontmatter description is present. A leading
 * markdown heading (which usually just repeats the practice name) is skipped in
 * favor of the first real line; if the body is only headings, the first
 * heading's text is the fallback.
 */
function leadingWords(body: string): string {
  let firstHeading = "";
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) {
      if (firstHeading === "") firstHeading = trimmed.replace(/^#+\s*/, "");
      continue;
    }
    return trimmed;
  }
  return firstHeading;
}
