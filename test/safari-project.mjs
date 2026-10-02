// Pure project-file regression: never builds, signs, installs or launches an app.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBundleIdentifiers } from "../scripts/safari.mjs";

const directory = mkdtempSync(join(tmpdir(), "anagram-safari-project-"));
try {
  const project = join(directory, "Anagram.xcodeproj");
  mkdirSync(project);
  mkdirSync(join(directory, "Anagram"));
  const controller = join(directory, "Anagram/ViewController.swift");
  writeFileSync(controller, 'let extensionBundleIdentifier = "old.Extension"\n');
  const source = join(project, "project.xcproj");
  // Xcode's modern format has trailing commas. Preserve unrelated settings and IDs.
  writeFileSync(source, `{
    "targets": [
      { "name": "Anagram", "id": "app-id", "product-type": "application", "build-settings": { "PRODUCT_BUNDLE_IDENTIFIER": "old", "DEVELOPMENT_TEAM": "KEEPTEAM", }, },
      { "name": "Anagram Extension", "id": "extension-id", "product-type": "app-extension", "build-settings": { "PRODUCT_BUNDLE_IDENTIFIER": "Wrong.Case.Extension", }, },
    ],
  }`);
  setBundleIdentifiers(project, "dev.example.Anagram");
  const value = JSON.parse(readFileSync(source, "utf8"));
  assert.equal(value.targets[0]["build-settings"].PRODUCT_BUNDLE_IDENTIFIER, "dev.example.Anagram");
  assert.equal(value.targets[1]["build-settings"].PRODUCT_BUNDLE_IDENTIFIER, "dev.example.Anagram.Extension");
  assert.equal(value.targets[0]["build-settings"].DEVELOPMENT_TEAM, "KEEPTEAM");
  assert.equal(value.targets[1].id, "extension-id");
  assert.match(readFileSync(controller, "utf8"), /"dev\.example\.Anagram\.Extension"/);
  console.log("Safari project identifiers and settings passed");
} finally { rmSync(directory, { recursive: true, force: true }); }
