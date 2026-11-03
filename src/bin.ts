#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`Erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 3;
  },
);
