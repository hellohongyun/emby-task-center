#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const repository = "ghcr.io/hellohongyun/emby-task-center";
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--skip-build", "--publish"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("Release version must use X.Y.Z in root package.json");
}

const image = `${repository}:${version}`;
function docker(...command) {
  execFileSync("docker", command, { cwd: root, stdio: "inherit" });
}

if (!args.has("--skip-build")) {
  const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  const changes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const source =
    revision.status === 0 ? `${revision.stdout.trim()}${changes.stdout?.trim() ? "-worktree" : ""}` : "unknown";
  docker(
    "build",
    "--platform",
    "linux/amd64",
    "--provenance=false",
    "--sbom=false",
    "--build-arg",
    `BUILD_VERSION=${version}`,
    "--build-arg",
    `BUILD_REVISION=${source}`,
    "-t",
    image,
    "-t",
    `emby-task-center:${version}`,
    ".",
  );
}

const [metadata] = JSON.parse(execFileSync("docker", ["image", "inspect", image], { cwd: root, encoding: "utf8" }));
if (
  metadata.Os !== "linux" ||
  metadata.Architecture !== "amd64" ||
  metadata.Config.Labels?.["org.opencontainers.image.version"] !== version
) {
  throw new Error("Image platform or OCI version does not match the release");
}
docker(
  "run",
  "--rm",
  "--network=none",
  "--read-only",
  "--entrypoint=node",
  image,
  "--eval",
  `const fs=require('node:fs'); const actual=JSON.parse(fs.readFileSync('/app/public/version.json','utf8')).version; if(actual!==${JSON.stringify(version)}) throw Error('Frontend and image version differ'); console.log('Frontend and image version: '+actual);`,
);

if (args.has("--publish")) {
  // A fixed version is immutable. Only an explicit registry "not found" permits a new release.
  const existing = spawnSync("docker", ["manifest", "inspect", image], { cwd: root, encoding: "utf8" });
  if (existing.status === 0) throw new Error(`${image} already exists; increment package.json version`);
  if (!/manifest unknown|no such manifest|not found/i.test(`${existing.stdout}\n${existing.stderr}`)) {
    throw new Error(
      `Cannot verify fixed-version availability: ${existing.stderr || existing.error || existing.stdout}`,
    );
  }
  docker("push", image);
  docker("tag", image, `${repository}:latest`);
  docker("push", `${repository}:latest`);
  console.log(`Published ${image} and ${repository}:latest from the same image.`);
} else {
  console.log(`Built and verified ${image}. Run release checks before --skip-build --publish.`);
}
