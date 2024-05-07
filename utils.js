const { spawn } = require("child_process");

// Function to calculate total size of all files
function calculateTotalSize(fileList) {
    let totalSize = 0;

    for (const file of fileList) {
        totalSize += file.size;
    }

    return totalSize;
}

// Function to format bytes into megabytes
function formatBytesToMb(bytes) {
    return (bytes / 1024 / 1024).toFixed(2);
}

// Function to format bytes into kilobytes
function formatBytesToKb(bytes) {
    return (bytes / 1024).toFixed(2);
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

function getFileName(filePath) {
    const fileName = filePath.split("/").pop();
    if (fileName.length <= 20) {
        return fileName;
    } else {
        return fileName.slice(0, 10) + "..." + fileName.slice(-10);
    }
}

module.exports = {
    calculateTotalSize,
    formatBytesToMb,
    formatBytesToKb,
    openBrowser,
    getFileName,
};
