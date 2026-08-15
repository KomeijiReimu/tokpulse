import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import presetSolid from "babel-preset-solid";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDirectory = join(root, "src");
const outputDirectory = join(root, "dist");

await mkdir(outputDirectory, { recursive: true });

async function compile(sourcePath, presets) {
  const source = await readFile(sourcePath, "utf8");
  const result = await transform(source, {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    sourceMaps: false,
    presets,
  });

  if (!result?.code) {
    throw new Error(`Babel produced no output for ${relative(root, sourcePath)}`);
  }

  const outputPath = join(outputDirectory, `${basename(sourcePath, extname(sourcePath))}.js`);
  await writeFile(outputPath, `${result.code}\n`, "utf8");
}

const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true });
for (const entry of sourceEntries) {
  if (!entry.isFile() || extname(entry.name) !== ".ts") continue;
  await compile(join(sourceDirectory, entry.name), [
    [presetTypescript, { allowDeclareFields: true }],
  ]);
}

const tuiSourcePath = join(sourceDirectory, "tui.tsx");
try {
  await readFile(tuiSourcePath);
  await compile(tuiSourcePath, [
    [presetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
    [presetTypescript, { allExtensions: true, isTSX: true }],
  ]);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
