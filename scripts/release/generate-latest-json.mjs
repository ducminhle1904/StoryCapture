#!/usr/bin/env node
// scripts/release/generate-latest-json.mjs
//
// Emit a Tauri v2 updater manifest (latest.json) for the tag currently
// being released. Expected to run inside the `publish` job of
// `.github/workflows/release.yml` AFTER the `build` matrix has uploaded
// all platform installers + updater bundles + `.sig` signatures to the
// GitHub Release as draft assets.
//
// Output is written to stdout — the workflow redirects to `latest.json`
// and re-uploads it to the same release.
//
// Manifest format:
// https://v2.tauri.app/plugin/updater/#server-support (static JSON)
//
// Required env:
//   GITHUB_REPOSITORY   = "owner/repo"
//   GITHUB_REF_NAME     = tag name, e.g. "v0.1.0"
//   GITHUB_TOKEN        = repo token with read access to releases
//
// Assumptions:
//   - Release `tag_name` == GITHUB_REF_NAME.
//   - Updater bundles follow Tauri's default naming:
//       macOS  : *.app.tar.gz       (+ *.sig)
//       Windows: *-setup.nsis.zip   (+ *.sig)  OR *.msi.zip (+ *.sig)
//   - Each bundle has a sibling `.sig` asset.

import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const token = process.env.GITHUB_TOKEN;

if (!repo || !tag || !token) {
  console.error(
    "missing env: GITHUB_REPOSITORY / GITHUB_REF_NAME / GITHUB_TOKEN required",
  );
  process.exit(2);
}

const version = tag.replace(/^v/, "");

const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
const resp = await fetch(api, {
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
if (!resp.ok) {
  console.error(`GitHub API ${resp.status}: ${await resp.text()}`);
  process.exit(1);
}
const release = await resp.json();
const assets = release.assets ?? [];

// Classify assets by platform / bundle vs signature.
// Tauri platforms: "darwin-aarch64" | "darwin-x86_64" | "windows-x86_64".
const platforms = {};

function ensure(p) {
  if (!platforms[p]) platforms[p] = { signature: "", url: "" };
  return platforms[p];
}

for (const asset of assets) {
  const name = asset.name;
  const url = asset.browser_download_url;
  const isSig = name.endsWith(".sig");
  // macOS updater bundles: <stuff>.app.tar.gz[.sig]
  if (name.includes(".app.tar.gz")) {
    const plat = name.includes("aarch64")
      ? "darwin-aarch64"
      : "darwin-x86_64";
    if (isSig) ensure(plat).signature = await fetchText(url, token);
    else ensure(plat).url = url;
    continue;
  }
  // Windows NSIS updater bundles: <stuff>-setup.nsis.zip[.sig]
  if (name.endsWith("-setup.nsis.zip") || name.endsWith(".nsis.zip.sig")) {
    const plat = "windows-x86_64";
    if (isSig) ensure(plat).signature = await fetchText(url, token);
    else ensure(plat).url = url;
    continue;
  }
  // Windows MSI updater bundles (alternate): <stuff>.msi.zip[.sig]
  if (name.endsWith(".msi.zip") || name.endsWith(".msi.zip.sig")) {
    const plat = "windows-x86_64";
    if (isSig) ensure(plat).signature = await fetchText(url, token);
    else if (!platforms[plat]?.url) ensure(plat).url = url;
    continue;
  }
}

async function fetchText(url, tkn) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${tkn}`, Accept: "application/octet-stream" },
  });
  if (!r.ok) {
    console.error(`signature fetch ${url} → ${r.status}`);
    process.exit(1);
  }
  return (await r.text()).trim();
}

const manifest = {
  version,
  notes: release.body || `Release ${tag}`,
  pub_date: release.published_at || new Date().toISOString(),
  platforms,
};

process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
