#!/usr/bin/env node
'use strict';

const { computeCron } = require('./lib/reminder.js');
process.stdout.write(computeCron(new Date()) + '\n');
