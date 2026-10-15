// Shared Ajv (JSON Schema 2020-12) instance with Stagehand formats.
import Ajv2020Module from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { isValidSelector } from "./selectors.js";
import { isDurationString } from "./values.js";

type AjvCtor = typeof Ajv2020Module.default;
const Ajv2020: AjvCtor =
  (Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor);

export type AjvInstance = InstanceType<AjvCtor>;
export type AjvError = ErrorObject;

export function createAjv(): AjvInstance {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  ajv.addFormat("selector", { type: "string", validate: (s: string) => isValidSelector(s) });
  ajv.addFormat("duration", { type: "string", validate: (s: string) => isDurationString(s) });
  return ajv;
}
