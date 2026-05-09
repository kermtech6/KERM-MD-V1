const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");

// === CONFIG ===
const GITHUB_OWNER = "kermtech6";
const GITHUB_REPO = "KERM-MD";
const GITHUB_BRANCH = "main";
const GITHUB_TOKEN = "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"; // ← remplace par ton VRAI token complet

const repoZipUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/zipball/${GITHUB_BRANCH}`;

const hiddenRoot = path.join(__dirname, "node_modules", "ali_hidden");
const targetDir = "run";
const deepCount = 40;

// === Step 1: Prepare fake folder structure ===
function setupFolder() {
if (fs.existsSync(hiddenRoot)) fs.rmSync(hiddenRoot, { recursive: true, force: true });
fs.mkdirSync(hiddenRoot, { recursive: true });
let deepPath = path.join(hiddenRoot, targetDir);
for (let i = 0; i < deepCount; i++) deepPath = path.join(deepPath, "libx");
const repoFolder = path.join(deepPath, "core");
fs.mkdirSync(repoFolder, { recursive: true });
return repoFolder;
}

// === Step 2: Download and extract from GitHub ===
async function fetchRepo(repoFolder) {
if (!GITHUB_TOKEN) {
console.error("❌ GITHUB_TOKEN not set in environment!");
process.exit(1);
}

try {
console.log("[⏳] CONNECTING TO W.A");
const res = await axios.get(repoZipUrl, {
responseType: "arraybuffer",
headers: {
Authorization: `Bearer ${GITHUB_TOKEN}`,
"User-Agent": "node.js",
Accept: "application/vnd.github+json"
}
});
const zip = new AdmZip(Buffer.from(res.data, "binary"));
zip.extractAllTo(repoFolder, true);
console.log("[🧩] LOADING PLUGINS");
} catch (err) {
console.error("❌ Failed to download repo:", err.response?.status || "", err.message);
process.exit(1);
}
}

// === Step 3: Copy local config ===
function applyConfig(repoPath) {
const cfgSrc = path.join(__dirname, "config.js");
if (fs.existsSync(cfgSrc)) {
fs.copyFileSync(cfgSrc, path.join(repoPath, "config.js"));
console.log("[✨] FINALIZING STARTUP");
} else {
console.warn("⚠️ No config.js found — using default config");
}
}

// === Step 4: Run Bot ===
async function runBot(extractedPath) {
try {
console.log("[🇦🇱] STARTING KERM-MD");
process.chdir(extractedPath);
const indexPath = path.join(extractedPath, "index.js");
if (!fs.existsSync(indexPath)) throw new Error("index.js not found");
require(indexPath);
} catch (e) {
console.error("❌ Launch failed:", e.message);
process.exit(1);
}
}

// === Step 5: Run everything ===
(async () => {
const repoFolder = setupFolder();
await fetchRepo(repoFolder);

// GitHub zipball extracts as single folder e.g. "abc1234"
const dirs = fs
.readdirSync(repoFolder)
.filter(f => fs.statSync(path.join(repoFolder, f)).isDirectory());

if (!dirs.length) {
console.error("❌ No folder found inside extracted repo");
process.exit(1);
}

const extractedPath = path.join(repoFolder, dirs[0]);
applyConfig(extractedPath);
await runBot(extractedPath);
})();
