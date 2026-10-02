import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Tests may inject private faults; production source must use package exports.
/** @type {Record<string, string[]>} */
const allowed = {
  types: [],
  evaluator: [],
  engine: ["types", "evaluator"],
  sdk: ["types"],
  api: ["types", "engine"],
  custody: ["types", "api"],
};
const failures = [];
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
/** @param {string} owner @param {string} file @param {string} specifier */
function checkImport(owner, file, specifier) {
  const match = /^@pokertools\/([^/]+)(.*)$/.exec(specifier);
  if (match) {
    const [, target, subpath] = match;
    if (target !== owner && !allowed[owner].includes(target))
      failures.push(`${relative(root, file)}: forbidden ${specifier}`);
    if (
      owner === "custody" &&
      target === "api" &&
      !["/finance-core", "/database"].includes(subpath)
    )
      failures.push(`${relative(root, file)}: custody must use key-free exported API ports`);
  }
  if (
    specifier.startsWith(".") &&
    relative(resolve(root, "packages", owner), resolve(dirname(file), specifier)).startsWith("../")
  )
    failures.push(`${relative(root, file)}: cross-package relative import ${specifier}`);
  if (owner === "types" && (specifier.startsWith("node:") || builtins.has(specifier)))
    failures.push(`${relative(root, file)}: environment-dependent protocol schema`);
}
/** @param {string} owner @param {string} directory */
function scan(owner, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) scan(owner, file);
    else if (/\.tsx?$/.test(entry.name)) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      /** @param {import("typescript").Node} node */
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          checkImport(owner, file, node.moduleSpecifier.text);
        else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) checkImport(owner, file, argument.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
for (const [owner, targets] of Object.entries(allowed)) {
  const manifest = z
    .object({ name: z.string(), dependencies: z.record(z.string(), z.string()).optional() })
    .parse(JSON.parse(readFileSync(resolve(root, "packages", owner, "package.json"), "utf8")));
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    if (
      dependency.startsWith("@pokertools/") &&
      !targets.includes(dependency.slice("@pokertools/".length))
    )
      failures.push(`${manifest.name}: forbidden runtime dependency ${dependency}`);
  scan(owner, resolve(root, "packages", owner, "src"));
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log("Package dependency boundaries verified.");
