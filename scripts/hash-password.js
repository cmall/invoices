#!/usr/bin/env node
'use strict';
// Prints a password hash for ADMIN_PASSWORD_HASH. Usage: npm run hash-password [-- "password"]
const { hashPassword } = require('../src/auth');

const pw = process.argv[2];
if (pw) {
  console.log(hashPassword(pw));
} else {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Password: ', (answer) => {
    rl.close();
    console.log(hashPassword(answer));
  });
}
