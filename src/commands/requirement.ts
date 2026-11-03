import { addDays, daysBetween, isIsoDate, todayIso, type Attestation, type Decision, type DecisionType } from "../lib/decisions.js";
import { usageError } from "../lib/errors.js";
import { atomicWrite, safeJoin, toJson } from "../lib/fsx.js";
import { PATHS, loadProject, resolveRoot, scopesFor } from "../lib/project.js";
import { ExitCode, canPrompt, nowFromEnv, prompt, result, type CommandResult, type Globals } from "./common.js";

export const REQUIREMENT_HELP = `Uso: repoguide requirement <ação> <id> [opções]

Registra decisões humanas explícitas em .ai/decisoes.json. O nome em --by é uma
declaração, não uma autenticação: a governança acontece na revisão do PR no GitHub.
Uma IA só pode executar estes comandos com autorização explícita do usuário.

Ações:
  defer <id>           Adia (exige --until, --reason, --by). Continua em acompanhamento.
  waive <id>           Dispensa (exige --reason, --by; --review-by opcional/limitado).
  not-applicable <id>  Declara não aplicável (exige --reason, --by).
  attest <id>          Declara evidência operacional verificada por uma pessoa
                       (exige --note, --by; --until opcional, padrão 180 dias, máx. 365).
  reset <id>           Encerra a decisão/declaração ativa, movendo-a para o histórico
                       (exige --reason, --by; use --attestation para a declaração).

Opções comuns:
  -C, --cwd <dir>   Diretório do projeto
      --scope <id>  Escopo (obrigatório em monorepo para requisitos por aplicação)
      --dry-run     Mostra a alteração sem gravar
      --no-input    Nunca pergunta; falha se faltar argumento
      --json        Saída JSON

Exemplos:
  repoguide requirement defer RG-OBS-001 --until 2026-12-31 --reason "Lançamento em janeiro" --by "Maria"
  repoguide requirement not-applicable RG-PRD-001 --scope api --reason "API interna sem público" --by "João"
  repoguide requirement attest RG-OBS-001 --note "Alerta de teste recebido no canal #ops" --by "Maria"
  repoguide requirement reset RG-OBS-001 --reason "Monitoramento implantado" --by "Maria"
`;

export interface RequirementFlags {
  scope?: string;
  reason?: string;
  by?: string;
  until?: string;
  "review-by"?: string;
  note?: string;
  evidence?: string;
  attestation?: boolean;
  "dry-run"?: boolean;
}

const ACTIONS = ["defer", "waive", "not-applicable", "attest", "reset"] as const;
type Action = (typeof ACTIONS)[number];

async function need(g: Globals, value: string | undefined, flag: string, question: string, min = 1): Promise<string> {
  let v = value?.trim();
  if (!v && canPrompt(g)) v = await prompt(question);
  if (!v) throw usageError(`Argumento obrigatório ausente: ${flag}`, "Em modo não interativo todos os argumentos são obrigatórios.");
  if (v.length < min) throw usageError(`${flag} muito curto (mínimo ${min} caracteres).`);
  if (v.length > 1000) throw usageError(`${flag} muito longo (máximo 1000 caracteres).`);
  return v;
}

export async function runRequirement(g: Globals, action: string | undefined, id: string | undefined, f: RequirementFlags): Promise<CommandResult> {
  if (!action || !ACTIONS.includes(action as Action)) throw usageError(`Ação inválida: ${action ?? "(nenhuma)"}`, `Use: ${ACTIONS.join(", ")}`);
  if (!id) throw usageError("Informe o ID do requisito.");
  const root = resolveRoot(g.cwd);
  const project = loadProject(root);
  const req = project.catalog.requirements.find((r) => r.id === id.toUpperCase());
  if (!req) throw usageError(`Requisito desconhecido: ${id}`, `IDs: ${project.catalog.requirements.map((r) => r.id).join(", ")}`);
  const scopes = scopesFor(req.scopeLevel, project.config).map((s) => s.id);
  let scope = f.scope;
  if (!scope) {
    if (scopes.length === 1) scope = scopes[0]!;
    else throw usageError(`${req.id} é avaliado por aplicação; informe --scope (${scopes.join(", ")}).`);
  }
  if (!scopes.includes(scope)) throw usageError(`Escopo ${scope} não se aplica a ${req.id}. Válidos: ${scopes.join(", ")}`);

  const now = nowFromEnv();
  const today = todayIso(now);
  const file = project.decisions;
  const lines: string[] = [];
  let summary: Record<string, unknown>;

  if (action === "reset") {
    const reason = await need(g, f.reason, "--reason", "Motivo do encerramento: ", 3);
    const by = await need(g, f.by, "--by", "Responsável (nome): ");
    if (f.attestation) {
      const idx = file.attestations.findIndex((a) => a.requirement === req.id && a.scope === scope);
      if (idx < 0) throw usageError(`Nenhuma declaração registrada para ${req.id}@${scope}.`);
      const [old] = file.attestations.splice(idx, 1);
      file.history.push({ kind: "attestation", entry: old!, endedAt: today, endedBy: by, endReason: reason });
      lines.push(`Declaração de ${req.id}@${scope} encerrada e movida para o histórico.`);
    } else {
      const idx = file.decisions.findIndex((d) => d.requirement === req.id && d.scope === scope);
      if (idx < 0) throw usageError(`Nenhuma decisão registrada para ${req.id}@${scope}.`);
      const [old] = file.decisions.splice(idx, 1);
      file.history.push({ kind: "decision", entry: old!, endedAt: today, endedBy: by, endReason: reason });
      lines.push(`Decisão (${old!.type}) de ${req.id}@${scope} encerrada e movida para o histórico. O requisito volta a ser cobrado.`);
    }
    summary = { action, requirement: req.id, scope };
  } else if (action === "attest") {
    const note = await need(g, f.note, "--note", "O que foi verificado e como: ", 10);
    const by = await need(g, f.by, "--by", "Responsável (nome): ");
    let expires = f.until ?? addDays(today, 180);
    if (!isIsoDate(expires) || expires <= today) throw usageError(`--until inválido: ${expires} (use AAAA-MM-DD no futuro)`);
    if (daysBetween(today, expires) > 365) throw usageError("Declarações valem no máximo 365 dias; evidência operacional precisa ser renovada.");
    const att: Attestation = { requirement: req.id, scope, note, declaredBy: by, date: today, requirementRevision: req.revision, expires, ...(f.evidence ? { evidence: f.evidence } : {}) };
    const idx = file.attestations.findIndex((a) => a.requirement === req.id && a.scope === scope);
    if (idx >= 0) {
      file.history.push({ kind: "attestation", entry: file.attestations[idx]!, endedAt: today, endedBy: by, endReason: "substituída por nova declaração" });
      file.attestations.splice(idx, 1);
    }
    file.attestations.push(att);
    expires = att.expires;
    lines.push(`Declaração registrada para ${req.id}@${scope}, válida até ${expires}.`);
    lines.push("Ela só complementa critérios operacionais; critérios estáticos ainda precisam ser observados no código.");
    summary = { action, requirement: req.id, scope, attestation: att };
  } else {
    const type: DecisionType = action === "defer" ? "deferred" : action === "waive" ? "waived" : "not-applicable";
    const reason = await need(g, f.reason, "--reason", "Justificativa: ", 10);
    const by = await need(g, f.by, "--by", "Responsável (nome): ");
    const decision: Decision = { requirement: req.id, scope, type, reason, declaredBy: by, date: today, requirementRevision: req.revision };
    if (type === "deferred") {
      const until = await need(g, f.until, "--until", "Adiar até (AAAA-MM-DD): ");
      if (!isIsoDate(until) || until <= today) throw usageError(`--until inválido: ${until} (data futura AAAA-MM-DD)`);
      if (daysBetween(today, until) > req.decisionPolicy.maxDeferralDays) {
        throw usageError(`Adiamento máximo para ${req.id}: ${req.decisionPolicy.maxDeferralDays} dias (até ${addDays(today, req.decisionPolicy.maxDeferralDays)}).`);
      }
      decision.expires = until;
    } else if (f.until) {
      throw usageError("--until é usado apenas em defer. Para revisão futura use --review-by.");
    }
    if (type !== "deferred") {
      const max = type === "waived" ? req.decisionPolicy.maxWaiverDays : null;
      let reviewBy = f["review-by"];
      if (reviewBy !== undefined && (!isIsoDate(reviewBy) || reviewBy <= today)) throw usageError(`--review-by inválido: ${reviewBy}`);
      if (max !== null) {
        if (reviewBy === undefined) {
          reviewBy = addDays(today, max);
          lines.push(`Revisão da dispensa definida para ${reviewBy} (limite da política: ${max} dias).`);
        } else if (daysBetween(today, reviewBy) > max) throw usageError(`Dispensa de ${req.id} deve ser revista em até ${max} dias.`);
      }
      if (reviewBy) decision.reviewBy = reviewBy;
    }
    const idx = file.decisions.findIndex((d) => d.requirement === req.id && d.scope === scope);
    if (idx >= 0) {
      file.history.push({ kind: "decision", entry: file.decisions[idx]!, endedAt: today, endedBy: by, endReason: `substituída por ${type}` });
      file.decisions.splice(idx, 1);
      lines.push("A decisão anterior foi movida para o histórico.");
    }
    file.decisions.push(decision);
    file.decisions.sort((a, b) => (a.requirement + a.scope).localeCompare(b.requirement + b.scope));
    const label = type === "deferred" ? `adiado até ${decision.expires}` : type === "waived" ? "dispensado" : "não aplicável";
    lines.unshift(`${req.id}@${scope} registrado como ${label}.`);
    if (type === "deferred") lines.push("Adiamento mantém o requisito em acompanhamento; não significa atendimento.");
    if (type === "waived") lines.push("Dispensa encerra a cobrança enquanto válida; o requisito não passa a constar como implementado.");
    summary = { action, requirement: req.id, scope, decision };
  }
  if (!f["dry-run"]) atomicWrite(safeJoin(root, PATHS.decisions), toJson(file));
  lines.push(f["dry-run"] ? "Simulação: .ai/decisoes.json não foi alterado." : "Gravado em .ai/decisoes.json — versione via PR para revisão.");
  return result(ExitCode.OK, lines, { ...summary, dryRun: !!f["dry-run"] });
}
