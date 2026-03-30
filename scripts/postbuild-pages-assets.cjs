const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(repoRoot, "dist", "assets");

const hashedAssetPattern = /^(?<base>.+)-(?<hash>[0-9a-f]{8})\.(?<ext>js|css)$/i;

const legacyAliases = {
  "index-a54d8997.js": "index.js",
  "admin-page-a189b1f5.js": "admin-page.js",
  "Select-16d00514.js": "Select.js",
  "Switch-e70b30fb.js": "Switch.js",
  "Checkbox-bbf6ab7e.js": "Checkbox.js",
  "Checkbox-9e00613d.js": "Checkbox.js",
  "MenuItem-36e9f0a4.js": "MenuItem.js",
  "Select-6aa1efff.js": "Select.js",
  "Switch-05a85a8f.js": "Switch.js",
  "SwitchBase-74f93f5a.js": "SwitchBase.js",
  "TextField-4fc9da5c.js": "TextField.js",
  "about-page-54ba3b42.js": "about-page.js",
  "admin-page-7607f998.js": "admin-page.js",
  "article-slug-page-b16d5e73.js": "article-slug-page.js",
  "category-feed-page-fd7c4517.js": "category-feed-page.js",
  "chips-component-36604514.js": "chips-component.js",
  "contact-page-69eee2ce.js": "contact-page.js",
  "editorial-policy-page-4be22e2a.js": "editorial-policy-page.js",
  "favorites-page-9c27fb8a.js": "favorites-page.js",
  "index-0629f1f1.js": "index.js",
  "kentucky-news-page-b0892828.js": "kentucky-news-page.js",
  "live-weather-alerts-page-4aeac642.js": "live-weather-alerts-page.js",
  "local-page-c173c2fc.js": "local-page.js",
  "national-page-3c10dfa9.js": "national-page.js",
  "post-page-0d3b34ac.js": "post-page.js",
  "privacy-policy-page-f69f806f.js": "privacy-policy-page.js",
  "saved-page-2aafeada.js": "saved-page.js",
  "schools-page-f67ab2c7.js": "schools-page.js",
  "search-page-0b0e603b.js": "search-page.js",
  "settings-page-7e4245ca.js": "settings-page.js",
  "sports-page-714f558f.js": "sports-page.js",
  "today-page-a063eceb.js": "today-page.js",
  "useFormControl-447f7a11.js": "useFormControl.js",
  "weather-page-dbdc4b1c.js": "weather-page.js",
};

function writeFileIfChanged(filePath, content) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === content) {
    return;
  }
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJsAlias(filePath, targetFileName) {
  const content = [
    `import * as targetModule from "./${targetFileName}";`,
    `export * from "./${targetFileName}";`,
    "export default targetModule.default ?? targetModule;",
    "",
  ].join("\n");
  writeFileIfChanged(filePath, content);
}

function writeCssAlias(filePath, targetFileName) {
  const content = `@import "./${targetFileName}";\n`;
  writeFileIfChanged(filePath, content);
}

if (!fs.existsSync(assetsDir)) {
  throw new Error(`Assets directory not found: ${assetsDir}`);
}

const assetFiles = fs
  .readdirSync(assetsDir)
  .filter((fileName) => fs.statSync(path.join(assetsDir, fileName)).isFile());

for (const fileName of assetFiles) {
  const match = hashedAssetPattern.exec(fileName);
  if (!match || !match.groups) {
    continue;
  }

  const stableName = `${match.groups.base}.${match.groups.ext.toLowerCase()}`;
  const stablePath = path.join(assetsDir, stableName);

  if (match.groups.ext.toLowerCase() === "js") {
    writeJsAlias(stablePath, fileName);
  } else {
    writeCssAlias(stablePath, fileName);
  }
}

for (const [legacyFileName, stableTargetName] of Object.entries(legacyAliases)) {
  const stableTargetPath = path.join(assetsDir, stableTargetName);
  if (!fs.existsSync(stableTargetPath)) {
    continue;
  }

  const legacyPath = path.join(assetsDir, legacyFileName);
  if (legacyFileName.toLowerCase().endsWith(".js")) {
    writeJsAlias(legacyPath, stableTargetName);
  } else if (legacyFileName.toLowerCase().endsWith(".css")) {
    writeCssAlias(legacyPath, stableTargetName);
  }
}
