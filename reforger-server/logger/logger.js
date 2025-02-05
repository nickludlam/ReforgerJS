const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize } = format;
const path = require('path');
const fs = require('fs');
const DailyRotateFile = require('winston-daily-rotate-file');

const config = require('../../config.json');

const consoleLogLevel = config.consoleLogLevel || 'info';
const outputLogLevel  = config.outputLogLevel  || 'info';

const logsDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

const customFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} ${level}: ${stack || message}`;
});

const logger = createLogger({
  level: 'verbose', 
  format: combine(
    timestamp(),
    format.errors({ stack: true }),
    customFormat
  ),
  transports: [
    new transports.Console({
      level: consoleLogLevel,
      format: combine(
        colorize({
          all: true,
          colors: {
            error: 'red',
            warn: 'yellow',
            info: 'white',
            verbose: 'green',
          },
        }),
        timestamp(),
        format.errors({ stack: true }),
        customFormat
      ),
    }),

    new DailyRotateFile({
      level: outputLogLevel,
      dirname: logsDir,
      filename: 'logs-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: '10',
      zippedArchive: true,
      format: combine(
        timestamp(),
        format.errors({ stack: true }),
        customFormat
      ),
    }),
  ],
});

if (!global.logger) {
  global.logger = logger;
}

process.on('uncaughtException', (error) => {
  const errorDetails = {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: error.code || null,
    signal: error.signal || null,
    additionalInfo: error.additionalInfo || null,
  };

  logger.error('Uncaught Exception:', errorDetails);
  console.error('Uncaught Exception Details:', errorDetails);
});

process.on('unhandledRejection', (reason, promise) => {
  const reasonDetails = {
    message: reason.message || reason,
    stack: reason.stack || null,
    name: reason.name || null,
  };

  logger.error(`Unhandled Rejection at: ${promise}`, reasonDetails);
  console.error('Unhandled Rejection Details:', reasonDetails); 
});

module.exports = logger;
