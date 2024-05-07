const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const axios = require("axios");
const { createServer } = require("http");
const { parse } = require("url");
const { Toggle, Form } = require("enquirer");
const { MultiBar, Presets } = require("cli-progress");
const {
    calculateTotalSize,
    formatBytesToKb,
    formatBytesToMb,
    openBrowser,
    getFileName,
} = require("./utils");

// Constants
const MAX_CONCURRENT_DOWNLOADS = 5;
const REQUEST_DELAY = 300; // in milliseconds

// Netlify API endpoint
const NETLIFY_API_ENDPOINT = "https://api.netlify.com/api/v1/sites/";
const REDIRECT_URI = "http://localhost:3000/callback.html";

// User variables
let SITE_ID = "";
let CLIENT_ID = "";
let AUTH_TOKEN = "";

// Check args for netlify IDs (-client and -site)
const args = process.argv.slice(2);
if (args.length > 0) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-client") {
            CLIENT_ID = args[i + 1];
        }
        if (args[i] === "-site") {
            SITE_ID = args[i + 1];
        }
    }
}

// Function to authenticate and get access token
async function authenticate() {
    return new Promise((resolve, reject) => {
        try {
            // Serve callback HTML file
            const server = createServer((req, res) => {
                const { pathname } = parse(req.url, true);
                if (pathname === "/callback") {
                    const { access_token } = parse(req.url, true).query;
                    if (access_token) {
                        // Close the server and resolve with the access token
                        res.end(
                            "Authentication successful! You can close this window now."
                        );
                        server.close();
                        resolve(access_token);
                    } else {
                        // Close the server and reject with an error
                        res.end("Authentication failed! Please try again.");
                        server.close();
                        reject(new Error("Authentication failed"));
                    }
                } else if (pathname === "/callback.html") {
                    // Read and serve the callback HTML file
                    fs.readFile("callback.html", (err, data) => {
                        if (err) {
                            res.writeHead(500);
                            res.end("Internal Server Error");
                            return;
                        }
                        res.writeHead(200, { "Content-Type": "text/html" });
                        res.end(data);
                    });
                }
            });
            server.listen(3000);

            // Open browser window for authentication
            const params = new URLSearchParams({
                response_type: "token",
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT_URI,
            });
            const authUrl = `https://app.netlify.com/authorize?${params.toString()}`;
            console.log(
                "Opening browser for authentication... Click the Authorize button when prompted."
            );
            openBrowser(authUrl);
        } catch (error) {
            console.error("Error during authentication:", error);
        }
    });
}

// Function to fetch file list from Netlify with pagination
async function getFileList(accessToken) {
    try {
        let fileList = [];

        const response = await axios.get(
            `${NETLIFY_API_ENDPOINT}${SITE_ID}/files`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        fileList = fileList.concat(response.data);

        return fileList;
    } catch (error) {
        console.error("Error fetching file list:", error);
        return [];
    }
}

// Function to download files
async function downloadFiles(fileList) {
    if (!fs.existsSync(path.join(__dirname, "downloads"))) {
        fs.mkdirSync(path.join(__dirname, "downloads"));
    }

    let totalDownloadedBytes = 0;
    let totalDownloadedFiles = 0;

    const progressBar = new MultiBar(
        {
            hideCursor: true,
            format: " {bar} | {filename} | {percentage}% | {kbCurrent}/{kbTotal} KB",
        },
        Presets.shades_grey
    );

    // Add bar for total
    const totalBar = progressBar.create(
        calculateTotalSize(fileList),
        0,
        {
            filename: "Total Progress",
            mbCurrent: 0,
            mbTotal: formatBytesToMb(calculateTotalSize(fileList)),
            currentFiles: 0,
            totalFiles: fileList.length,
        },
        {
            format: " {bar} | Total Progress | {percentage}% | {mbCurrent}/{mbTotal} MB | {currentFiles}/{totalFiles} files",
        }
    );

    // Download a single file
    async function downloadFile(path, dest, bar) {
        totalDownloadedFiles++;

        let fileTotalDownloadedBytes = 0;

        const response = await axios({
            method: "GET",
            url: `${NETLIFY_API_ENDPOINT}${SITE_ID}/files/${path}`,
            responseType: "stream",
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                "Content-Type": "application/vnd.bitballoon.v1.raw",
            },
        });

        response.data.on("data", (chunk) => {
            totalDownloadedBytes += chunk.length;
            fileTotalDownloadedBytes += chunk.length;

            const kb = formatBytesToKb(fileTotalDownloadedBytes);
            bar.increment(chunk.length, { kbCurrent: kb });
            totalBar.update(totalDownloadedBytes, {
                mbCurrent: formatBytesToMb(totalDownloadedBytes),
                currentFiles: totalDownloadedFiles,
            });
        });

        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);

        return new Promise((resolve) => {
            writer.on("finish", () => {
                bar.stop();
                resolve();
            });
            writer.on("error", (error) => {
                console.error("Error writing file:", error);
            });
        });
    }

    // Download a chunk of files with a maximum number of concurrent downloads
    async function downloadChunk(filesChunk) {
        const downloadPromises = [];

        for (const file of filesChunk) {
            const filePath = file.path;
            const directory = path.join(
                __dirname,
                `downloads/${SITE_ID}`,
                filePath.substring(0, filePath.lastIndexOf("/"))
            );
            const fullFilePath = path.join(directory, path.basename(filePath));

            if (!fs.existsSync(directory)) {
                fs.mkdirSync(directory, { recursive: true });
            }

            const totalSize = file.size;
            const fileName = getFileName(filePath);

            const bar = progressBar.create(totalSize, 0, {
                filename: fileName,
                kbCurrent: 0,
                kbTotal: formatBytesToKb(totalSize),
            });

            downloadPromises.push(
                downloadFile(filePath, fullFilePath, bar).then(() => {
                    progressBar.remove(bar);
                })
            );
        }

        await Promise.all(downloadPromises);
    }

    // Recursively download files from the entire list
    async function downloadAllFilesRecursive(filesList) {
        let startIndex = 0;

        while (startIndex < filesList.length) {
            const filesChunk = filesList.slice(
                startIndex,
                startIndex + MAX_CONCURRENT_DOWNLOADS
            );

            await downloadChunk(filesChunk);
            startIndex += MAX_CONCURRENT_DOWNLOADS;

            // Add delay
            if (startIndex < filesList.length) {
                await new Promise((resolve) =>
                    setTimeout(resolve, REQUEST_DELAY)
                );
            }
        }
    }

    await downloadAllFilesRecursive(fileList);

    totalBar.stop();
    progressBar.stop();

    console.log("All files downloaded successfully.");
}

// Function to zip files
async function zipFiles() {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const zipFileName = `${SITE_ID}_${timestamp}.zip`;
        const output = fs.createWriteStream(zipFileName);
        const archive = archiver("zip", {
            zlib: { level: 9 }, // Sets the compression level.
        });

        archive.on("error", function (err) {
            console.error("Error zipping files:", err);
            reject(err);
        });

        archive.pipe(output);
        archive.directory(path.join(__dirname, `downloads/${SITE_ID}`), false);
        archive.finalize();

        // wait for zip file to be created
        output.on("finish", () => {
            console.log("Zip file created:", zipFileName);
            // Delete site folder
            fs.rmSync(path.join(__dirname, `downloads/${SITE_ID}`), {
                recursive: true,
            });

            // Move zip file to downloads folder
            fs.rename(
                zipFileName,
                path.join(__dirname, "downloads", zipFileName),
                (err) => {
                    if (err) {
                        console.error("Error moving zip file:", err);
                    }
                }
            );

            resolve();
        });
    });
}

async function promptUserForZip() {
    const prompt = new Toggle({
        message: "Would you like to zip the files after download?",
        enabled: "Yes",
        disabled: "No",
    });

    return prompt.run();
}

async function promptUserForNetlifyIds() {
    const form = new Form({
        name: "Netlify IDs",
        message:
            "Please enter your Netlify App Client ID, and the Site ID you want to download files from.",
        choices: [
            { name: "CLIENT_ID", message: "Client ID", initial: CLIENT_ID },
            { name: "SITE_ID", message: "Site ID", initial: SITE_ID },
        ],
    });

    return form.run();
}

// Main function
async function main() {
    try {
        // Prompt user for Netlify IDs
        const netlifyInfo = await promptUserForNetlifyIds();

        SITE_ID = netlifyInfo.SITE_ID;
        CLIENT_ID = netlifyInfo.CLIENT_ID;

        // Prompt user to zip files
        const ZIP_FILES = await promptUserForZip();

        // Authenticate with Netlify
        const accessToken = await authenticate();

        if (!accessToken) {
            console.error("Failed to authenticate.");
            return;
        } else {
            AUTH_TOKEN = accessToken;
            console.log("Authentication successful! Fetching files...");
        }

        // Fetch file list
        const fileList = await getFileList(accessToken);

        if (!fileList || fileList.length === 0) {
            console.error("No files found.");
            return;
        } else {
            console.log(`Found ${fileList.length} files. Downloading...`);
        }

        // Download files
        await downloadFiles(fileList, accessToken);

        // Zip files
        if (ZIP_FILES) {
            console.log("Zipping files...");
            await zipFiles();
        }

        // Exit
        process.exit(0);
    } catch (error) {
        console.error("Error:", error);
    }
}

// Execute main function
main();
