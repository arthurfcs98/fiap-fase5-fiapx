/**
 * Runs the BDD step files in file-name order (01-... to 99-...). The default Jest sequencer
 * reorders by previous duration/failures, which would let the log check (99) run before the
 * scenarios whose logs it inspects.
 */
const Sequencer = require('@jest/test-sequencer').default;

class NameOrderSequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = NameOrderSequencer;
