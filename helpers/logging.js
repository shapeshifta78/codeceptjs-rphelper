const fs = require('fs');
const path = require('path');

module.exports = function logToFile(message) {
	const logsDirPath = path.resolve(output_dir, 'logs');

	const logFilePath = path.join(logsDirPath, 'codeceptjs-reportportal.log');

	if (!fs.existsSync(logsDirPath)) {
		fs.mkdirSync(logsDirPath, { recursive: true });
	}

	const timestamp = new Date().toISOString();
	const logMessage = `[${timestamp}] ${message}\n`;

	fs.appendFile(logFilePath, logMessage, (err) => {
		if (err) {
			console.error('Failed to write to log file:', err);
		}
	});
};
