#!/usr/bin/env node

import { main } from './cli.ts'

process.exitCode = main(process.argv.slice(2))
