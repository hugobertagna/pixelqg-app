'use strict';

// Entry point for `node --test server/test` (Node resolves a directory argument to
// this index.js): loads every *.test.js file of this folder in one test process.
// Running `node --test "server/test/*.test.js"` works as well (one process per file).

const fs = require('node:fs');
const path = require('node:path');

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith('.test.js')) require(path.join(__dirname, file));
}
