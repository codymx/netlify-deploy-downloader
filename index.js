const axios = require("axios");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const http = require("http");
const { spawn } = require("child_process");
const { parse } = require("url");
const ProgressBar = require("progress");
const { Toggle, Form } = require("enquirer");

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

// Function to calculate total size of all files
function calculateTotalSize(fileList) {
    let totalSize = 0;

    for (const file of fileList) {
        totalSize += file.size;
    }

    return totalSize;
}

// Function to format bytes into megabytes
function formatBytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(2);
}

// Function to open URL in default browser
function openBrowser(url) {
    return new Promise((resolve, reject) => {
        const child = spawn("open", [url]);

        child.on("error", (err) => {
            reject(err);
        });

        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Failed to open browser (exit code ${code})`));
            }
        });
    });
}

// Function to authenticate and get access token
async function authenticate() {
    return new Promise((resolve, reject) => {
        try {
            // Serve callback HTML file
            const server = http.createServer((req, res) => {
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

// Function to download files with exact directory structure
async function downloadFiles(fileList) {
    // Check for existing working directory and delete if found
    if (fs.existsSync(path.join(__dirname, `downloads/${SITE_ID}`))) {
        fs.rmSync(path.join(__dirname, `downloads/${SITE_ID}`), {
            recursive: true,
        });
    }

    try {
        let currentFileIndex = 0;
        let totalBytesDownloaded = 0;
        const totalSize = calculateTotalSize(fileList);
        const progressBar = new ProgressBar(
            "[:bar] :percent :fileCurrent/:filesTotal files [:mbCurrent/:mbTotal MB]",
            {
                complete: "█",
                incomplete: "░",
                width: 30,
                curr: 0,
                total: totalSize,
                callback: () => {
                    progressBar.terminate();
                },
            }
        );

        for (const file of fileList) {
            currentFileIndex++;

            const filePath = file.path;
            const directory = path.join(
                __dirname,
                `downloads/${SITE_ID}`,
                filePath.substring(0, filePath.lastIndexOf("/"))
            );

            if (!fs.existsSync(directory)) {
                fs.mkdirSync(directory, { recursive: true });
            }

            const fullFilePath = path.join(directory, path.basename(filePath));
            const response = await axios({
                method: "GET",
                url: `${NETLIFY_API_ENDPOINT}${SITE_ID}/files/${filePath}`,
                responseType: "stream",
                headers: {
                    Authorization: `Bearer ${AUTH_TOKEN}`,
                },
            });

            // Write file stream to disk
            const writer = fs.createWriteStream(fullFilePath);
            response.data.pipe(writer);

            // Update progress bar
            response.data.on("data", (chunk) => {
                totalBytesDownloaded += chunk.length;

                // update curr
                progressBar.curr = totalBytesDownloaded;

                progressBar.tick({
                    fileCurrent: currentFileIndex,
                    filesTotal: fileList.length,
                    mbCurrent: formatBytes(totalBytesDownloaded),
                    mbTotal: formatBytes(totalSize),
                });
            });

            // Update total bytes downloaded
            response.data.on("end", () => {
                totalBytesDownloaded += file.size;

                // if it's the last one, set progress to total
                if (currentFileIndex === fileList.length) {
                    progressBar.curr = totalSize;
                    progressBar.tick({
                        fileCurrent: currentFileIndex,
                        filesTotal: fileList.length,
                        mbCurrent: formatBytes(totalSize),
                        mbTotal: formatBytes(totalSize),
                    });
                }
            });

            // Wait for file to be written
            await new Promise((resolve, reject) => {
                writer.on("finish", () => {
                    resolve();
                });
                writer.on("error", reject);
            });
        }
    } catch (error) {
        console.error("Error downloading files:", error);
    }
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

        output.on("close", function () {
            console.log(`Zip file ${zipFileName} created successfully.`);
        });

        archive.on("error", function (err) {
            console.error("Error zipping files:", err);
            reject(err);
        });

        archive.pipe(output);
        archive.directory(".", false);
        archive.finalize();

        // wait for zip file to be created
        output.on("finish", () => {
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
            console.log(`Found ${fileList.length} files. Starting download...`);
        }

        // Download files
        await downloadFiles(fileList, accessToken);

        console.log("Download complete!");

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
