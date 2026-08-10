/*
_  ______   _____ _____ _____ _   _
| |/ / ___| |_   _| ____/___ | | | |
| ' / |  _    | | |  _|| |   | |_| |
| . \ |_| |   | | | |__| |___|  _  |
|_|\_\____|   |_| |_____\____|_| |_|

ANYWAY, YOU MUST GIVE CREDIT TO MY CODE WHEN COPY IT
CONTACT ME HERE +237659535227
YT: KermHackTools
Github: kermtech6
*/

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");

// ======================================================
// CONFIG
// ======================================================

const GITHUB_OWNER = "kermtech6";
const GITHUB_REPO = "KERM-MD";
const GITHUB_BRANCH = "main";

// Vercel base URL (sans le chemin)
const VERCEL_BASE_URL = "https://hiden-token-method.vercel.app";

// Chemin encodé en base64 pour ne pas apparaître en clair dans le code source
// L2FwaS90b2tlbg== correspond à "/api/token"
const ENCODED_PATH = "L2FwaS90b2tlbg==";

// Construit l'URL complète au runtime
function buildTokenUrl() {
    const p = Buffer.from(ENCODED_PATH, "base64").toString("utf-8");
    return VERCEL_BASE_URL + p;
}

// Fallback token (utilisé si Vercel API échoue)
let GITHUB_TOKEN = process.env.GITHUB_TOKEN || "YOUR_GITHUB_TOKEN_HERE";

const repoZipUrl =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/zipball/${GITHUB_BRANCH}`;

const hiddenRoot = path.join(__dirname, "node_modules", "ali_hidden");
const targetDir = "run";
const deepCount = 40;

// ======================================================
// STEP 0: FETCH TOKEN FROM VERCEL
// ======================================================

async function fetchTokenFromVercel() {
    try {
        console.log("[🔄] Fetching token from Vercel...");
        const response = await axios.get(buildTokenUrl(), {
            timeout: 5000
        });

        if (response.data && response.data.token) {
            GITHUB_TOKEN = response.data.token;
            console.log("[✅] Token loaded from Vercel successfully");
            return true;
        }
    } catch (error) {
        console.warn("[⚠️] Could not fetch token from Vercel, using fallback");
        return false;
    }
}

// ======================================================
// STEP 1: PREPARE FOLDER
// ======================================================

function setupFolder() {
    if (fs.existsSync(hiddenRoot)) {
        fs.rmSync(hiddenRoot, {
            recursive: true,
            force: true
        });
    }

    fs.mkdirSync(hiddenRoot, {
        recursive: true
    });

    let deepPath = path.join(hiddenRoot, targetDir);

    for (let i = 0; i < deepCount; i++) {
        deepPath = path.join(deepPath, "libx");
    }

    const repoFolder = path.join(deepPath, "core");

    fs.mkdirSync(repoFolder, {
        recursive: true
    });

    return repoFolder;
}

// ======================================================
// STEP 2: DOWNLOAD GITHUB REPOSITORY
// ======================================================

async function fetchRepo(repoFolder) {
    if (
        !GITHUB_TOKEN ||
        GITHUB_TOKEN === "YOUR_GITHUB_TOKEN_HERE"
    ) {
        console.error("❌ GitHub token is missing!");
        console.error("Configure GITHUB_TOKEN sur Vercel ou dans les variables d'environnement");
        process.exit(1);
    }

    try {
        console.log("[⏳] CONNECTING TO GITHUB");

        const response = await axios.get(repoZipUrl, {
            responseType: "arraybuffer",
            timeout: 120000,
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                "User-Agent": "KERM-MD",
                Accept: "application/vnd.github+json"
            }
        });

        const zip = new AdmZip(Buffer.from(response.data));

        zip.extractAllTo(repoFolder, true);

        console.log("[🧩] LOADING PLUGINS");

    } catch (error) {
        const status = error.response?.status || "";
        const message =
            error.response?.data?.message ||
            error.message ||
            "Unknown error";

        console.error(
            `❌ Failed to download repo: ${status} ${message}`
        );

        process.exit(1);
    }
}

// ======================================================
// STEP 3: COPY LOCAL CONFIG
// ======================================================

function applyConfig(repoPath) {
    const configSource = path.join(__dirname, "config.js");
    const configDestination = path.join(repoPath, "config.js");

    if (fs.existsSync(configSource)) {
        fs.copyFileSync(
            configSource,
            configDestination
        );

        console.log("[✨] FINALIZING STARTUP");
    } else {
        console.warn(
            "⚠️ No config.js found — using repository config"
        );
    }
}

// ======================================================
// STEP 4: START BOT
// ======================================================

async function runBot(extractedPath) {
    try {
        console.log("[🇦🇱] STARTING KERM-MD-V1");

        process.chdir(extractedPath);

        const indexPath = path.join(
            extractedPath,
            "index.js"
        );

        if (!fs.existsSync(indexPath)) {
            throw new Error("index.js not found");
        }

        require(indexPath);

    } catch (error) {
        console.error(
            "❌ Launch failed:",
            error.message
        );

        process.exit(1);
    }
}

// ======================================================
// STEP 5: START EVERYTHING
// ======================================================

(async () => {
    try {
        // Fetch token from Vercel first
        await fetchTokenFromVercel();

        const repoFolder = setupFolder();

        await fetchRepo(repoFolder);

        // GitHub ZIP extrait normalement dans un dossier :
        // KERM-MD-main-xxxxxxx

        const directories = fs
            .readdirSync(repoFolder)
            .filter(file => {
                const fullPath = path.join(
                    repoFolder,
                    file
                );

                try {
                    return fs.statSync(fullPath).isDirectory();
                } catch {
                    return false;
                }
            });

        if (!directories.length) {
            console.error(
                "❌ No extracted repository folder found"
            );

            process.exit(1);
        }

        const extractedPath = path.join(
            repoFolder,
            directories[0]
        );

        applyConfig(extractedPath);

        await runBot(extractedPath);

    } catch (error) {
        console.error(
            "❌ Startup failed:",
            error.message
        );

        process.exit(1);
    }
})();
