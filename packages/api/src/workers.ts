#!/usr/bin/env node
/**
 * Workers Entry Point
 *
 * Run this as a separate process to handle background jobs:
 * npm run workers
 */

import "./workers/index.js";

console.log("✅ Workers process started");
