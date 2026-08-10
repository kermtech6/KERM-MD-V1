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

// Add your GitHub token here
const GITHUB_TOKEN = "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";

const repoZipUrl =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/zipball/${GITHUB_BRANCH}`;

const hiddenRoot = path.join(__dirname, "node_modules", "ali_hidden");
const targetDir = "run";
const deepCount = 40;

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
        GITHUB_TOKEN === "YOUR TOKEN HERE"
    ) {
        console.error("❌ GitHub token is missing!");
        console.error("Set GITHUB_TOKEN environment variable or replace 'YOUR_GITHUB_TOKEN_HERE' in the code");
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
        const repoFolder = setupFolder();

        await fetchRepo(repoFolder);

        // GitHub ZIP normally extracts into:
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
