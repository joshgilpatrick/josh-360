import type { Logger } from '../../src/util/log.ts'

// A no-op Logger for tests that exercise a failure/warning path but don't assert on the log
// output itself. createLogger(null) writes warn/error lines to stderr, which is correct for a
// real deployment (nothing else would surface them) but is just noise in a test run. Tests that
// DO assert on log content should keep using createLogger(logPath) and read the file back.
export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
