import { parseArgs, type ParseArgsConfig } from "node:util";
import { CHECK_HELP, runCheck } from "./commands/check.js";
import { envelope, errorEnvelope, type CommandResult, type Globals } from "./commands/common.js";
import { DOCTOR_HELP, runDoctor } from "./commands/doctor.js";
import { EXPLAIN_HELP, runExplain } from "./commands/explain.js";
import { GITHUB_HELP, runInstallWorkflows, runSyncIssues, runUpdatePr } from "./commands/github.js";
import { INIT_HELP, runInit } from "./commands/init.js";
import { REQUIREMENT_HELP, runRequirement } from "./commands/requirement.js";
import { UPDATE_HELP, runUpdate } from "./commands/update.js";
import { cliVersion } from "./lib/content.js";
import { ExitCode, RgError } from "./lib/errors.js";

const MAIN_HELP = `repoguide — orientações para desenvolvimento assistido por IA e acompanhamento de requisitos.

Uso: repoguide <comando> [opções]

Comandos:
  init                         Instala em projeto novo ou existente (offline)
  check                        Checagem curta para o início de sessão/tarefa
  explain <id>                 Detalhes de um requisito
  update                       Adota explicitamente uma nova versão
  doctor                       Diagnóstico da instalação
  requirement <ação> <id>      defer | waive | not-applicable | attest | reset
  github <ação>                sync-issues | update-pr | install-workflows (opcional)

Opções globais:
  -C, --cwd <dir>   Diretório do projeto       --json      Saída JSON estável
  -h, --help        Ajuda                       --version   Versão da CLI
      --no-input    Nunca faz perguntas interativas

Códigos de saída: 0 ok · 1 violação bloqueante/limite atingido · 2 uso inválido
                  3 falha de execução · 4 conflito (nada escrito) · 5 falha remota

Idioma das instruções distribuídas: português (pt-BR).
Ajuda de um comando: repoguide <comando> --help
`;

type Opts = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL: Opts = {
  cwd: { type: "string", short: "C" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "no-input": { type: "boolean" },
};

const COMMANDS: Record<string, { help: string; options: Opts }> = {
  init: {
    help: INIT_HELP,
    options: { "dry-run": { type: "boolean" }, claude: { type: "boolean" }, "github-workflows": { type: "boolean" }, scope: { type: "string", multiple: true } },
  },
  check: {
    help: CHECK_HELP,
    options: {
      offline: { type: "boolean" },
      refresh: { type: "boolean" },
      timeout: { type: "string" },
      "fail-on": { type: "string" },
      "max-items": { type: "string" },
      repo: { type: "string" },
      "no-cache": { type: "boolean" },
    },
  },
  explain: { help: EXPLAIN_HELP, options: { scope: { type: "string" }, offline: { type: "boolean" }, timeout: { type: "string" } } },
  update: {
    help: UPDATE_HELP,
    options: {
      "dry-run": { type: "boolean" },
      to: { type: "string" },
      "from-package": { type: "boolean" },
      offline: { type: "boolean" },
      source: { type: "string" },
      "allow-major": { type: "boolean" },
      "allow-downgrade": { type: "boolean" },
      claude: { type: "boolean" },
      "github-workflows": { type: "boolean" },
      timeout: { type: "string" },
    },
  },
  doctor: { help: DOCTOR_HELP, options: { offline: { type: "boolean" }, timeout: { type: "string" } } },
  requirement: {
    help: REQUIREMENT_HELP,
    options: {
      scope: { type: "string" },
      reason: { type: "string" },
      by: { type: "string" },
      until: { type: "string" },
      "review-by": { type: "string" },
      note: { type: "string" },
      evidence: { type: "string" },
      attestation: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  },
  github: {
    help: GITHUB_HELP,
    options: {
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
      offline: { type: "boolean" },
      source: { type: "string" },
      timeout: { type: "string" },
      to: { type: "string" },
    },
  },
};

export async function main(argv: string[]): Promise<number> {
  const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
  const command = argv.find((a) => !a.startsWith("-"));
  const wantsJson = argv.includes("--json");
  if (!command) {
    if (argv.includes("--version") || argv.includes("-v")) {
      out(cliVersion());
      return ExitCode.OK;
    }
    out(MAIN_HELP);
    return argv.length === 0 || argv.includes("--help") || argv.includes("-h") ? ExitCode.OK : ExitCode.USAGE;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    process.stderr.write(`Comando desconhecido: ${command}\n\n${MAIN_HELP}`);
    return ExitCode.USAGE;
  }
  try {
    const rest = argv.slice(argv.indexOf(command) + 1);
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({ args: [...argv.slice(0, argv.indexOf(command)), ...rest], options: { ...GLOBAL, ...spec.options }, allowPositionals: true, strict: true });
    } catch (e) {
      throw new RgError(ExitCode.USAGE, (e as Error).message, { hint: `Veja: repoguide ${command} --help` });
    }
    const v = parsed.values as Record<string, unknown>;
    if (v.help) {
      out(spec.help);
      return ExitCode.OK;
    }
    const g: Globals = { cwd: v.cwd as string | undefined, json: !!v.json, noInput: !!v["no-input"] };
    const pos = parsed.positionals;
    let res: CommandResult;
    switch (command) {
      case "init":
        res = await runInit(g, v);
        break;
      case "check":
        res = await runCheck(g, v);
        break;
      case "explain":
        res = await runExplain(g, pos[0], v);
        break;
      case "update":
        res = await runUpdate(g, v);
        break;
      case "doctor":
        res = await runDoctor(g, v);
        break;
      case "requirement":
        res = await runRequirement(g, pos[0], pos[1], v);
        break;
      case "github": {
        const action = pos[0];
        if (action === "sync-issues") res = await runSyncIssues(g, v);
        else if (action === "update-pr") res = await runUpdatePr(g, v);
        else if (action === "install-workflows") res = await runInstallWorkflows(g, v);
        else throw new RgError(ExitCode.USAGE, `Ação desconhecida: ${action ?? "(nenhuma)"}`, { hint: "Use sync-issues, update-pr ou install-workflows." });
        break;
      }
      default:
        return ExitCode.USAGE;
    }
    if (g.json) out(JSON.stringify(envelope(command, res), null, 2));
    else out(res.lines.join("\n"));
    return res.exitCode;
  } catch (e) {
    const err =
      e instanceof RgError
        ? e
        : new RgError(ExitCode.EXECUTION, `Erro inesperado: ${(e as Error)?.message ?? String(e)}`, { hint: "Execute `repoguide doctor`. Se persistir, abra uma issue com a saída." });
    if (wantsJson) out(JSON.stringify(errorEnvelope(command, err), null, 2));
    else {
      process.stderr.write(`Erro: ${err.message}\n`);
      for (const d of err.details.slice(0, 20)) process.stderr.write(`  - ${d}\n`);
      if (err.hint) process.stderr.write(`Dica: ${err.hint}\n`);
    }
    return err.exitCode;
  }
}
