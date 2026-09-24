#!/usr/bin/env node
/**
 * The Safari app in safari/Zunia wraps the web extension built into .output/safari-mv3.
 * Xcode lists that folder's top-level entries one by one, so a new entrypoint would be left
 * out of the app without any error. `check` catches that, and a drift between the app version
 * and package.json. `build` then compiles the app for macOS and the iOS Simulator without
 * signing, and confirms the web extension landed inside each app extension.
 *
 * Usage: node scripts/safari.mjs check | build
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webExtDir = path.join(rootDir, ".output", "safari-mv3");
const project = path.join(rootDir, "safari", "Zunia", "Zunia.xcodeproj");
const derivedData = path.join(rootDir, ".output", "safari-xcode");
const REFERENCE = /path = "\.\.\/\.\.\/\.\.\/\.output\/safari-mv3\/([^"]+)"/g;

function check() {
  if (!fs.existsSync(path.join(webExtDir, "manifest.json"))) {
    return [".output/safari-mv3 is missing, run pnpm build:safari first"];
  }
  const problems = [];
  const pbxproj = fs.readFileSync(path.join(project, "project.pbxproj"), "utf8");
  const referenced = new Set([...pbxproj.matchAll(REFERENCE)].map((match) => match[1]));
  const built = new Set(fs.readdirSync(webExtDir).filter((name) => !name.startsWith(".")));
  for (const name of built) {
    if (!referenced.has(name)) problems.push(`${name} is in the build but not in the Xcode project`);
  }
  for (const name of referenced) {
    if (!built.has(name)) problems.push(`the Xcode project lists ${name}, which the build no longer has`);
  }

  const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const versions = new Set([...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((match) => match[1]));
  if (versions.size !== 1 || !versions.has(version)) {
    problems.push(`MARKETING_VERSION is ${[...versions].join(", ")}, package.json says ${version}`);
  }
  return problems;
}

function xcodebuild(args) {
  execFileSync("xcodebuild", ["-project", project, "-configuration", "Release", "-derivedDataPath", derivedData, "-quiet", ...args], {
    stdio: "inherit",
  });
}

function build() {
  if (process.platform !== "darwin") {
    console.error("Building the Safari app needs macOS and Xcode.");
    process.exit(1);
  }
  // Signing and distribution need the Zunia Lab Apple team. These builds prove that the
  // project compiles and packages the extension: ad hoc signed for macOS, unsigned for the
  // Simulator.
  xcodebuild([
    "-scheme", "Zunia (macOS)",
    "-destination", "generic/platform=macOS",
    "CODE_SIGN_STYLE=Manual", "CODE_SIGN_IDENTITY=-", "DEVELOPMENT_TEAM=",
    "build",
  ]);
  xcodebuild([
    "-scheme", "Zunia (iOS)",
    "-destination", "generic/platform=iOS Simulator",
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ]);

  const products = path.join(derivedData, "Build", "Products");
  const bundles = {
    macOS: path.join(products, "Release", "Zunia.app", "Contents", "PlugIns", "Zunia Extension.appex", "Contents", "Resources"),
    "iOS Simulator": path.join(products, "Release-iphonesimulator", "Zunia.app", "PlugIns", "Zunia Extension.appex"),
  };
  let missing = false;
  for (const [platform, dir] of Object.entries(bundles)) {
    for (const file of ["manifest.json", "background.js", "zunia_core_bg.wasm", "popup.html"]) {
      if (!fs.existsSync(path.join(dir, file))) {
        console.error(`${platform}: ${file} is missing from ${path.relative(rootDir, dir)}`);
        missing = true;
      }
    }
    if (!missing) console.log(`ok   ${platform}: ${path.relative(rootDir, dir)}`);
  }
  if (missing) process.exit(1);
}

const command = process.argv[2];
if (command !== "check" && command !== "build") {
  console.error("Usage: node scripts/safari.mjs check | build");
  process.exit(2);
}
const problems = check();
if (problems.length > 0) {
  console.error("The Safari Xcode project does not match .output/safari-mv3:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "Add a new file to both extension targets in Xcode as a reference relative to its group, " +
      "or remove the stale one. See docs/browsers.md#safari.",
  );
  process.exit(1);
}
console.log("ok   Safari project matches .output/safari-mv3");
if (command === "build") build();
