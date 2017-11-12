#!/usr/bin/env node

const path = require('path');

const client = require(path.join(__dirname, '..', 'client'));
client();

setTimeout(() => {}, 10 * 1000);
