import { Logger } from '@nestjs/common';

// Unit tests assert on logs through spies on Logger.prototype; the console output is noise.
// `LOGS=1 npm test` shows it.
if (process.env['LOGS'] !== '1') Logger.overrideLogger(false);
