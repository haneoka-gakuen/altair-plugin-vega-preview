import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const policy = Object.freeze({
  name: "@haneoka/altair-plugin-vega-preview",
  repository: "git+https://github.com/haneoka-gakuen/altair-plugin-vega-preview.git",
  peers: Object.freeze([
    "@haneoka/altair",
    "@haneoka/altair-plugin-adv",
    "@haneoka/altair-preview-client",
    "@haneoka/vega",
    "@haneoka/vega-protocol",
  ]),
  maximumBytes: 1024 * 1024,
});

const allowedRuntimeImports = new Set([
  "@haneoka/altair/model",
  "@haneoka/altair/plugins",
  "@haneoka/altair-plugin-adv/services",
  "@haneoka/altair-preview-client",
  "@haneoka/vega/engine",
  "@haneoka/vega/preview",
  "@haneoka/vega-protocol",
]);

const fail = (message) => {
  throw new Error(`Package verification failed: ${message}`);
};

if (manifest.name !== policy.name) fail(`name must be ${policy.name}`);
if (manifest.license !== "MPL-2.0") fail("license must be MPL-2.0");
if (manifest.private === true) fail("package cannot be private");
if (manifest.sideEffects !== false) fail("sideEffects must be false");
if (manifest.type !== "module") fail("package type must be module");
if (manifest.engines?.node !== ">=20") fail("Node.js engine must be >=20");
if (manifest.publishConfig?.access !== "public") {
  fail("publishConfig.access must be public");
}
if (manifest.publishConfig?.provenance !== true) {
  fail("publishConfig.provenance must be enabled");
}
if (manifest.repository?.url !== policy.repository) {
  fail(`repository.url must be ${policy.repository}`);
}
if (manifest.altair?.pluginApi !== 2) {
  fail("Altair plugin API must be 2");
}
if (manifest.altair?.dependencies?.["haneoka.altair-adv"] !== "^0.1.0") {
  fail("Altair ADV plugin dependency must be declared");
}

const forbiddenDependency = /(?:live2d|cubism|motionsync|@esotericsoftware|spine|pixi)/iu;
for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (forbiddenDependency.test(name)) {
      fail(`forbidden SDK/runtime dependency ${name} in ${section}`);
    }
  }
}
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail("runtime dependencies must be peer dependencies");
}
if (Object.keys(manifest.optionalDependencies ?? {}).length > 0) {
  fail("optional runtime dependencies are not allowed");
}
for (const key of ["bundledDependencies", "bundleDependencies"]) {
  if (Array.isArray(manifest[key]) && manifest[key].length > 0) {
    fail(`${key} are not allowed`);
  }
}

const actualPeers = Object.keys(manifest.peerDependencies ?? {}).sort();
const expectedPeers = [...policy.peers].sort();
if (JSON.stringify(actualPeers) !== JSON.stringify(expectedPeers)) {
  fail(`peer dependencies must be exactly ${expectedPeers.join(", ")}`);
}

const collectTargets = (value) => {
  if (typeof value === "string") {
    return value.startsWith("./dist/") ? [value] : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectTargets);
};

const targets = new Set(
  [manifest.main, manifest.module, manifest.types, ...collectTargets(manifest.exports)].filter(
    (value) => typeof value === "string" && value.startsWith("./dist/"),
  ),
);
if (targets.size === 0) fail("manifest has no dist export targets");
for (const target of targets) {
  try {
    await access(resolve(root, target));
  } catch {
    fail(`manifest references missing build output ${target}`);
  }
}

const restrictedPath =
  /(?:^|\/)(?:character-models?|game-assets?|models?|sdk|vendor)(?:\/|$)|\.(?:moc|moc3|model3\.json|motion3\.json|physics3\.json|cdi3\.json|exp3\.json|skel|atlas|wasm|dll|dylib|so|node)$/iu;
const mediaPath =
  /(?:^|\/)(?:assets?|textures?|motions?|physics)(?:\/|$)|\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp3|ogg|wav|m4a|mp4|webm)$/iu;
const ignoredRoots = new Set([".dependencies", ".git", "coverage", "dist", "node_modules"]);
const repositoryFiles = [];

const insideRoot = (path) => {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !pathFromRoot.startsWith(sep))
  );
};

const walkRepository = async (path, relativePath = "") => {
  if (!insideRoot(path)) fail(`path escapes repository: ${path}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    fail(`symbolic links are not allowed: ${relativePath}`);
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (!relativePath && ignoredRoots.has(entry)) continue;
      await walkRepository(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
    }
    return;
  }
  repositoryFiles.push(relativePath);
};

await walkRepository(root);
const restrictedRepositoryFiles = repositoryFiles.filter((path) => restrictedPath.test(path) || mediaPath.test(path));
if (restrictedRepositoryFiles.length > 0) {
  fail(`restricted SDK, runtime, model, or asset payload:\n${restrictedRepositoryFiles.join("\n")}`);
}

const publishableFiles = [];
let publishableBytes = 0;
const walkPublishable = async (path, relativePath) => {
  if (!insideRoot(path)) {
    fail(`publish path escapes repository: ${relativePath}`);
  }
  const canonical = await realpath(path);
  if (!insideRoot(canonical)) {
    fail(`publish path resolves outside repository: ${relativePath}`);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    fail(`publish path is a symbolic link: ${relativePath}`);
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await walkPublishable(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
    }
    return;
  }
  publishableFiles.push(relativePath);
  publishableBytes += (await stat(path)).size;
  const bytes = await readFile(path);
  if (bytes.includes(0)) fail(`binary payload found in ${relativePath}`);
};

await walkPublishable(resolve(root, "package.json"), "package.json");
for (const entry of manifest.files ?? []) {
  if (typeof entry !== "string" || !entry || entry.startsWith("/") || entry.includes("*")) {
    fail(`invalid package files entry ${String(entry)}`);
  }
  const path = resolve(root, entry);
  if (!insideRoot(path)) {
    fail(`package files entry escapes repository: ${entry}`);
  }
  await walkPublishable(path, entry);
}

const restrictedPublishableFiles = publishableFiles.filter((path) => restrictedPath.test(path) || mediaPath.test(path));
if (restrictedPublishableFiles.length > 0) {
  fail(`restricted publish payload:\n${restrictedPublishableFiles.join("\n")}`);
}
if (publishableBytes > policy.maximumBytes) {
  fail(`publish payload is unexpectedly large (${publishableBytes} bytes)`);
}

const builtJavaScriptFiles = publishableFiles.filter((path) => path.startsWith("dist/") && path.endsWith(".js"));
if (builtJavaScriptFiles.length === 0) {
  fail("package has no built JavaScript");
}
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu;
const externalImports = new Set();
for (const path of repositoryFiles.filter((path) => path.startsWith("src/") && path.endsWith(".ts"))) {
  const source = await readFile(resolve(root, path), "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier && !specifier.startsWith(".") && !allowedRuntimeImports.has(specifier)) {
      fail(`unexpected source runtime import in ${path}: ${specifier}`);
    }
  }
}
for (const path of builtJavaScriptFiles) {
  const source = await readFile(resolve(root, path), "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier && !specifier.startsWith(".")) {
      externalImports.add(specifier);
    }
  }
  if (/Live2D Cubism (?:Core|SDK)|Spine Runtimes License Agreement/iu.test(source)) {
    fail(`restricted vendor runtime fingerprint in ${path}`);
  }
}

const unexpectedImports = [...externalImports].filter((specifier) => !allowedRuntimeImports.has(specifier));
if (unexpectedImports.length > 0) {
  fail(`unexpected runtime imports: ${unexpectedImports.join(", ")}`);
}
const forbiddenAltairFeatureImports = [...externalImports].filter(
  (specifier) =>
    specifier === "@haneoka/altair" ||
    specifier.startsWith("@haneoka/altair/compile") ||
    specifier.startsWith("@haneoka/altair/vega") ||
    specifier.startsWith("@haneoka/altair/commands") ||
    specifier.startsWith("@haneoka/altair/validation"),
);
if (forbiddenAltairFeatureImports.length > 0) {
  fail(`Altair feature implementation imports are forbidden: ${forbiddenAltairFeatureImports.join(", ")}`);
}

console.log(
  `Verified ${manifest.name}: ${targets.size} exports, ${publishableFiles.length} files, ${publishableBytes} bytes.`,
);
