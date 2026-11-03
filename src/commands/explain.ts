import { usageError } from "../lib/errors.js";
import { EFFECTIVE_LABEL, RESULT_LABEL, evaluate } from "../lib/evaluate.js";
import { loadProject, resolveRoot } from "../lib/project.js";
import { ExitCode, nowFromEnv, parseTimeout, result, type CommandResult, type Globals } from "./common.js";

export const EXPLAIN_HELP = `Uso: repoguide explain <id> [opções]

Mostra os detalhes de um requisito: critérios, como é verificado, evidências observadas,
decisões registradas e como resolver. Use quando o check apontar uma pendência.

Opções:
  -C, --cwd <dir>      Diretório do projeto
      --scope <id>     Limita a um escopo
      --offline        Não acessa a rede
      --timeout <ms>   Tempo limite de rede
      --json           Saída JSON

Exemplo:
  repoguide explain RG-OBS-001
`;

export interface ExplainFlags {
  scope?: string;
  offline?: boolean;
  timeout?: string;
}

export async function runExplain(g: Globals, id: string | undefined, f: ExplainFlags): Promise<CommandResult> {
  if (!id) throw usageError("Informe o ID do requisito.", "Exemplo: repoguide explain RG-OBS-001");
  const root = resolveRoot(g.cwd);
  const project = loadProject(root);
  const req = project.catalog.requirements.find((r) => r.id === id.toUpperCase());
  if (!req) {
    throw usageError(`Requisito desconhecido: ${id}`, `IDs disponíveis: ${project.catalog.requirements.map((r) => r.id).join(", ")}`);
  }
  const { evaluation, cache } = await evaluate(project, {
    offline: !!f.offline,
    refresh: false,
    now: nowFromEnv(),
    timeoutMs: parseTimeout(f.timeout, project.config.timeoutMs),
    only: [req.id],
  });
  cache.save();
  const items = evaluation.items.filter((i) => !f.scope || i.scope === f.scope);
  if (f.scope && items.length === 0) throw usageError(`Escopo ${f.scope} não se aplica a ${req.id}.`);

  const L: string[] = [];
  L.push(`${req.id} — ${req.title}  (revisão ${req.revision}; categoria ${req.category}; severidade ${req.severity}${req.blocking ? "; bloqueante" : ""})`);
  L.push(req.description, "");
  L.push(`Aplicabilidade: ${req.applicability.summary}`);
  L.push("Critérios de aceite:");
  for (const c of req.acceptanceCriteria) L.push(`  - [${c.evidence === "static" ? "estático" : c.evidence === "operational" ? "operacional" : "declaração"}] ${c.text}`);
  L.push(`Ferramentas sugeridas: ${req.suggestedTools.join(", ")}`);
  if (req.acceptedEquivalents.length) L.push(`Equivalentes aceitos: ${req.acceptedEquivalents.join("; ")}`);
  L.push(`Verificação: ${req.verification.summary}`);
  L.push("Orientação:");
  for (const s of req.guidance) L.push(`  - ${s}`);
  L.push("");
  for (const it of items) {
    L.push(`Escopo ${it.scope}: ${EFFECTIVE_LABEL[it.effective]} (resultado observado: ${RESULT_LABEL[it.result]})`);
    for (const e of it.evidence) L.push(`  + [${e.kind === "static" ? "indício estático" : e.kind === "operational" ? "evidência operacional" : "declaração humana"}] ${e.detail}`);
    for (const r of it.reasons) L.push(`  ? ${r}`);
    if (it.decision) {
      const d = it.decision;
      L.push(`  Decisão: ${d.type} por ${d.declaredBy} em ${d.date}${d.expires ? `, vence ${d.expires}` : ""}${d.reviewBy ? `, revisar em ${d.reviewBy}` : ""} — ${d.reason}`);
      if (d.status !== "active") L.push(`  ⚠ decisão precisa de revisão: ${d.why}`);
    }
  }
  L.push("", "Para resolver: implemente os critérios e rode `repoguide check`.");
  L.push("Decisões (somente com autorização explícita do responsável):");
  L.push(`  repoguide requirement defer ${req.id} --until AAAA-MM-DD --reason "..." --by "Nome"`);
  L.push(`  repoguide requirement waive ${req.id} --reason "..." --by "Nome"`);
  L.push(`  repoguide requirement not-applicable ${req.id} --reason "..." --by "Nome"`);
  L.push(`  repoguide requirement attest ${req.id} --note "..." --by "Nome"   # declara evidência operacional`);
  return result(ExitCode.OK, L, { requirement: req, items });
}
