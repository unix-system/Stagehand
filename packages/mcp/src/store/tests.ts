// Tests store: playtests/<name>.playtest.yaml under the project root.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { stringifySpec } from "../spec/loader.js";
import type { Step } from "../spec/types.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const EXTS = [".playtest.yaml", ".playtest.yml", ".playtest.json"];
/** Shared fragments live beside the tests: playtests/_shared/<name>.fragment.yaml. */
export const SHARED_DIR = "_shared";
const FRAGMENT_EXTS = [".fragment.yaml", ".fragment.yml", ".fragment.json"];

export interface TestSummary {
  name: string;
  file: string;
  description: string | null;
  tags: string[];
  parseError: string | null;
}

export interface FragmentSummary {
  name: string;
  file: string;
  description: string | null;
  steps: Step[];
  parseError: string | null;
}

export class TestsStore {
  readonly dir: string;
  readonly sharedDir: string;
  constructor(root: string) {
    this.dir = path.join(root, "playtests");
    this.sharedDir = path.join(this.dir, SHARED_DIR);
  }

  static checkName(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`invalid test name "${name}" (use lowercase kebab-case: ^[a-z0-9][a-z0-9-]*$)`);
  }

  /** Shared fragments (`use: <name>`), parsed. A file that fails to parse is listed with its error. */
  async fragments(): Promise<FragmentSummary[]> {
    let files: string[];
    try {
      files = (await readdir(this.sharedDir)).filter((f) => FRAGMENT_EXTS.some((e) => f.endsWith(e))).sort();
    } catch {
      return [];
    }
    const out: FragmentSummary[] = [];
    for (const f of files) {
      const name = FRAGMENT_EXTS.reduce((n, e) => (n.endsWith(e) ? n.slice(0, -e.length) : n), f);
      const file = path.join(this.sharedDir, f);
      try {
        const v = YAML.parse(await readFile(file, "utf8")) as Record<string, unknown> | null;
        const steps = Array.isArray(v?.steps) ? (v.steps as Step[]) : null;
        if (!steps || steps.length === 0) throw new Error("a fragment file needs a non-empty `steps:` list");
        if (typeof v?.name === "string" && v.name !== name) throw new Error(`name "${v.name}" must match the file name "${name}"`);
        out.push({ name, file, description: typeof v?.description === "string" ? v.description : null, steps, parseError: null });
      } catch (e) {
        out.push({ name, file, description: null, steps: [], parseError: (e as Error).message });
      }
    }
    return out;
  }

  /** Shared fragments as the map the compiler takes (unparseable files are left out). */
  async fragmentMap(): Promise<Record<string, Step[]>> {
    const map: Record<string, Step[]> = {};
    for (const f of await this.fragments()) if (!f.parseError) map[f.name] = f.steps;
    return map;
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => EXTS.some((e) => f.endsWith(e))).sort();
    } catch {
      return [];
    }
  }

  async list(): Promise<TestSummary[]> {
    const out: TestSummary[] = [];
    for (const f of await this.files()) {
      const name = EXTS.reduce((n, e) => (n.endsWith(e) ? n.slice(0, -e.length) : n), f);
      const file = path.join(this.dir, f);
      try {
        const v = YAML.parse(await readFile(file, "utf8")) as Record<string, unknown> | null;
        out.push({
          name,
          file,
          description: typeof v?.description === "string" ? v.description : null,
          tags: Array.isArray(v?.tags) ? (v.tags as unknown[]).map(String) : [],
          parseError: null,
        });
      } catch (e) {
        out.push({ name, file, description: null, tags: [], parseError: (e as Error).message });
      }
    }
    return out;
  }

  async find(name: string): Promise<string | null> {
    TestsStore.checkName(name);
    const files = await this.files();
    for (const e of EXTS) if (files.includes(name + e)) return path.join(this.dir, name + e);
    return null;
  }

  async get(name: string): Promise<{ name: string; file: string; text: string } | null> {
    const file = await this.find(name);
    if (!file) return null;
    return { name, file, text: await readFile(file, "utf8") };
  }

  /** Save YAML text as-is (keeps comments) or serialize an object. Returns the file path. */
  async save(name: string, spec: string | object): Promise<string> {
    TestsStore.checkName(name);
    await mkdir(this.dir, { recursive: true });
    const existing = await this.find(name);
    const file = existing ?? path.join(this.dir, `${name}.playtest.yaml`);
    let text: string;
    if (typeof spec === "string") text = spec.endsWith("\n") ? spec : `${spec}\n`;
    else if (file.endsWith(".json")) text = `${JSON.stringify(spec, null, 2)}\n`;
    else text = stringifySpec(spec);
    await writeFile(file, text, "utf8");
    return file;
  }

  async delete(name: string): Promise<boolean> {
    const file = await this.find(name);
    if (!file) return false;
    await rm(file);
    return true;
  }
}
