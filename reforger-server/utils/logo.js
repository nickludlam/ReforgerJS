const fs = require('fs');
const path = require('path');

function printLogo() {
    const logoPath = path.join(__dirname, 'logo.txt');
    let logo = fs.readFileSync(logoPath, 'utf8');

    logo = logo.replace(/\\x1b/g, '\x1b');
    logger.info(logo);

    // Load version
    try {
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        logger.info(`Current Version: ${packageJson.version}`);
    } catch (error) {
        logger.error('Error loading version from package.json:', error.message);
    }

    // Notice
    logger.info(
        `\nReforgerJS: Created by the ZSU Gaming!`
    );
}

module.exports = { printLogo };
