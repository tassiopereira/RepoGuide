// Builds the release assets for the stable channel into .release/:
//   repoguide-content.json  — content bundle (files + sha256 per file)
//   stable.json             — channel index (this release + previous ones, relative URLs)
//   SHA256SUMS              — checksums of all assets
//   tassiopereira-repoguide-<version>.tgz — npm package tarball (installable without the npm registry)
//
// Usage: node scripts/make-release-assets.mjs [--previous-index <path to previous stable.json>]
// Requires `npm run build` first.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".release");
mkdirSync(out, { recursive: true });

const { loadBundledContent } = await import(new URL("../build/src/lib/content.js", import.meta.url).href);
const bundle = loadBundledContent();
const bundleText = JSON.stringify(bundle, null, 2) + "\n";
const sha = (t) => createHash("sha256").update(t).digest("hex");
writeFileSync(path.join(out, "repoguide-content.json"), bundleText);

const prevArg = process.argv.indexOf("--previous-index");
let previous = [];
if (prevArg > 0 && existsSync(process.argv[prevArg + 1])) {
  const prev = JSON.parse(readFileSync(process.argv[prevArg + 1], "utf8"));
  if (prev.format === "repoguide-channel" && Array.isArray(prev.releases)) {
    // Previous entries become relative to this release's directory.
    previous = prev.releases
      .filter((r) => r.version !== bundle.version)
      .map((r) => ({ ...r, url: /^https?:/.test(r.url) ? r.url : r.url.startsWith("../") ? r.url : `../v${r.version}/repoguide-content.json` }));
  }
}
const index = {
  format: "repoguide-channel",
  channel: "stable",
  latest: bundle.version,
  releases: [
    { version: bundle.version, url: "repoguide-content.json", sha256: sha(bundleText), ...(bundle.highlights ? { highlights: bundle.highlights } : {}) },
    ...previous,
  ],
};
writeFileSync(path.join(out, "stable.json"), JSON.stringify(index, null, 2) + "\n");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = execFileSync(npm, ["pack", "--json", "--pack-destination", out], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
const tarball = JSON.parse(packed)[0].filename.replace(/^.*[\\/]/, "");
const expected = `tassiopereira-repoguide-${bundle.version}.tgz`;
if (tarball !== expected) renameSync(path.join(out, tarball), path.join(out, expected));

const sums = readdirSync(out)
  .filter((f) => f !== "SHA256SUMS")
  .sort()
  .map((f) => `${sha(readFileSync(path.join(out, f)))}  ${f}`)
  .join("\n");
writeFileSync(path.join(out, "SHA256SUMS"), sums + "\n");
console.log(`Release assets for ${bundle.version} written to ${path.relative(root, out)}/`);
console.log(sums);
