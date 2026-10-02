import { describe, expect, it } from "vitest";
import { IncidentKind, IncidentSeverity, IncidentStatus } from "../../generated/prisma/index.js";
import {
  IncidentKindSchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
} from "@pokertools/types";

describe("persisted incident wire contracts", () => {
  it.each([
    ["kind", IncidentKind, IncidentKindSchema],
    ["severity", IncidentSeverity, IncidentSeveritySchema],
    ["status", IncidentStatus, IncidentStatusSchema],
  ] as const)(
    "represents every persisted incident %s in the operator protocol",
    (_, persisted, schema) => {
      expect([...schema.options].sort()).toEqual(Object.values(persisted).sort());
    }
  );
});
