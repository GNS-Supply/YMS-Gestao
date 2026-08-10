// =====================================================================
// agendamentoOperacional.js
//
// ETAPA 2A — Função core para a Logística/Admin criarem um agendamento
// DIRETO no sistema (sem passar pelo fluxo Pendente -> Aprovado da
// Transportadora). Cobre dois casos de uso:
//
//   1) Empresa parceira JÁ CADASTRADA (tipo=1, aprovada) — a Logística
//      escolhe a transportadora num dropdown/autocomplete e o
//      agendamento fica vinculado ao usuarioId dela normalmente.
//   2) Parceiro pontual / avulso (não tem login no sistema) — a
//      Logística digita o nome da empresa na hora; o agendamento é
//      salvo com usuarioId = null e um flag indicando que não é uma
//      conta cadastrada.
//
// Em ambos os casos o booking já nasce com status "Aprovado" e
// tipoAgendamento: "Operacional" (ver TIPO_AGENDAMENTO em
// bookingSchema.js), e um log imutável é gravado em auditLogs deixando
// claro que foi a própria Logística/Admin quem criou o registro (e não
// uma solicitação da Transportadora seguida de aprovação).
//
// Reaproveita a MESMA lógica de concorrência/atomicidade já usada no
// fluxo da Transportadora (transportadora-dashboard.html): uma
// Firestore Transaction sobre o documento em `timeSlots`, criando-o de
// forma "lazy" se ainda não existir, incrementando `ocupados` com
// segurança mesmo se dois cliques acontecerem ao mesmo tempo.
//
// -----------------------------------------------------------------
// ⚠️ AVISO IMPORTANTE SOBRE AS FIRESTORE RULES (ainda não atualizadas
// nesta etapa, por pedido explícito — "não altere rules agora"):
//
// Do jeito que `rulles - firebase.txt` está hoje, a regra de create em
// `bookings` (`novoAgendamentoValido`) exige:
//   - d.usuarioId == request.auth.uid
//   - d.status == 'Pendente'
//
// Ou seja: hoje, um documento criado por esta função (usuarioId de
// OUTRA pessoa, ou null, com status "Aprovado") seria REJEITADO pelas
// Rules no momento da escrita real no Firestore. Esta etapa entrega só
// a lógica/JS (Etapa 2A); a atualização das Rules para liberar esse
// caso para Logística/Admin fica para uma etapa futura, quando for
// solicitada.
// -----------------------------------------------------------------
// =====================================================================

import {
  collection,
  doc,
  getDoc,
  addDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  horaParaMinutos,
  minutosParaHora,
  idSlotHorario,
  buscarSlotsVirtuaisDoDia
} from "./disponibilidade.js";
import { STATUS, TIPO_AGENDAMENTO } from "./bookingSchema.js";

const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// Usada apenas quando o horário informado não bate com nenhuma Regra
// Padrão/Exceção vigente para aquela data (Logística forçando um
// horário totalmente fora do padrão) e nenhuma capacidade manual foi
// informada em `dados.capacidadeManual`.
const CAPACIDADE_PADRAO_FORA_DO_PADRAO = 1;

/**
 * Busca o perfil de uma transportadora cadastrada (tipo=1) para validar
 * e/ou pré-preencher o nome da empresa. Retorna `null` se o id não foi
 * informado (parceiro pontual/avulso) ou se o usuário não existir.
 *
 * @param {Firestore} db
 * @param {string|null|undefined} transportadoraId
 * @returns {Promise<{uid: string, nome: string, empresa: string}|null>}
 */
export async function buscarTransportadoraCadastrada(db, transportadoraId) {
  if (!transportadoraId) return null;

  const snap = await getDoc(doc(db, "users", transportadoraId));
  if (!snap.exists()) {
    throw new Error("Transportadora cadastrada não encontrada.");
  }

  const dadosUser = snap.data();
  if (dadosUser.tipo !== 1) {
    throw new Error("O usuário selecionado não é uma conta de Transportadora.");
  }
  if (dadosUser.status !== "aprovado") {
    throw new Error("Esta transportadora ainda não está com o cadastro aprovado.");
  }

  return { uid: snap.id, nome: dadosUser.nome || "", empresa: dadosUser.empresa || "" };
}

function validarCamposObrigatorios(dados) {
  const erros = [];

  if (!dados.empresa || !String(dados.empresa).trim()) {
    erros.push("Nome da empresa é obrigatório.");
  }
  if (!dados.tipoProcessoId) {
    erros.push("Tipo de processo é obrigatório.");
  }
  if (!REGEX_DATA.test(dados.dataAgendada || "")) {
    erros.push("Data agendada inválida (use o formato AAAA-MM-DD).");
  }
  if (!REGEX_HORA.test(dados.horaInicio || "")) {
    erros.push("Horário de início inválido (use o formato HH:MM).");
  }
  if (!dados.placaCavalo || !String(dados.placaCavalo).trim()) {
    erros.push("Placa do cavalo é obrigatória.");
  }
  if (!dados.motorista || !String(dados.motorista).trim()) {
    erros.push("Nome do motorista é obrigatório.");
  }

  if (erros.length > 0) {
    throw new Error(erros.join(" "));
  }
}

/**
 * Consulta a capacidade "de referência" calculada pela Regra Padrão +
 * Exceções (+ eventual ajuste manual já existente) para o horário
 * escolhido. Serve só como valor inicial ao criar o documento em
 * `timeSlots` pela primeira vez — depois de criado, quem manda é o
 * próprio documento em `timeSlots` (igual ao restante do sistema).
 *
 * @returns {Promise<number|null>} capacidade sugerida, ou null se o
 *   horário estiver fora de qualquer Regra/Exceção vigente
 */
async function buscarCapacidadeReferencia(db, dataAgendada, horaInicio) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataAgendada, { incluirFechados: true });
  const slot = slots.find(s => s.horaInicio === horaInicio);
  return slot ? slot : null; // devolve o slot inteiro (tem capacidadeMax e fechado)
}

/**
 * Cria um agendamento OPERACIONAL: já nasce "Aprovado", registrado
 * diretamente pela Logística/Admin (sem passar pelo fluxo de
 * solicitação da Transportadora).
 *
 * @param {Firestore} db
 * @param {{uid: string}} usuarioLogado - usuário autenticado (Logística/Admin) que está fazendo o registro
 * @param {object} dados
 * @param {string|null} [dados.transportadoraId] - uid de uma transportadora JÁ CADASTRADA (tipo=1, aprovada).
 *   Deixe null/undefined para um parceiro pontual (texto livre em `dados.empresa`).
 * @param {string} dados.empresa - nome da empresa (obrigatório mesmo se transportadoraId for informado,
 *   permite corrigir/confirmar o nome na hora do registro)
 * @param {string} dados.tipoProcessoId
 * @param {string} dados.dataAgendada - "AAAA-MM-DD"
 * @param {string} dados.horaInicio - "HH:MM"
 * @param {string} dados.placaCavalo
 * @param {string} [dados.placaCarreta]
 * @param {string} dados.motorista
 * @param {string} [dados.observacoes]
 * @param {number} [dados.capacidadeManual] - usada só se o horário estiver fora de qualquer
 *   Regra Padrão/Exceção vigente (ver `buscarCapacidadeReferencia`) e o timeSlot ainda não existir
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.forcarAlemDaCapacidade=false] - se true, permite gravar mesmo sem vaga
 *   disponível, elevando `capacidadeMax` do timeSlot para acomodar o novo registro (mantém a
 *   invariante ocupados <= capacidadeMax exigida pelas Rules)
 * @param {boolean} [opcoes.ignorarFechado=false] - se true, permite agendar mesmo num horário
 *   fechado manualmente (`ativo: false`) para aquela data específica
 *
 * @returns {Promise<{
 *   bookingId: string, slotId: string, capacidadeMax: number,
 *   ocupados: number, capacidadeForcada: boolean
 * }>}
 */
export async function criarAgendamentoOperacional(db, usuarioLogado, dados, opcoes = {}) {
  const { forcarAlemDaCapacidade = false, ignorarFechado = false } = opcoes;

  if (!usuarioLogado || !usuarioLogado.uid) {
    throw new Error("Usuário da Logística/Admin não identificado.");
  }

  validarCamposObrigatorios(dados);

  // 1) Se for uma transportadora cadastrada, valida que ela existe, é
  //    tipo=1 e está aprovada (evita vincular a um uid inválido/errado).
  const transportadoraCadastrada = await buscarTransportadoraCadastrada(db, dados.transportadoraId);

  // 2) Trava de horário já passado, se a data escolhida for hoje —
  //    mesma lógica usada no formulário da Transportadora.
  const dataAgendada = dados.dataAgendada;
  const horaInicio = dados.horaInicio;
  const horaFim = minutosParaHora((horaParaMinutos(horaInicio) + 60) % (24 * 60));

  // 3) Capacidade de referência (Regra/Exceção/Manual já existente),
  //    calculada FORA da transação (leitura de várias coleções — não é
  //    possível fazer isso dentro de uma runTransaction do Firestore).
  const slotReferencia = await buscarCapacidadeReferencia(db, dataAgendada, horaInicio);
  if (slotReferencia && slotReferencia.fechado && !ignorarFechado) {
    throw new Error("Este horário está fechado manualmente para esta data. Use opcoes.ignorarFechado=true para forçar, se necessário.");
  }

  const slotId = idSlotHorario(dataAgendada, horaInicio);
  const slotRef = doc(db, "timeSlots", slotId);
  const bookingRef = doc(collection(db, "bookings"));

  let capacidadeMax;
  let ocupados;
  let capacidadeForcada = false;

  await runTransaction(db, async (transaction) => {
    const slotSnap = await transaction.get(slotRef);

    let capacidadeAtual;
    let ocupadosAtuais;

    if (slotSnap.exists()) {
      const slotData = slotSnap.data();
      if (slotData.ativo === false && !ignorarFechado) {
        throw new Error("Este horário foi fechado manualmente para esta data (entre a consulta e a gravação).");
      }
      capacidadeAtual = slotData.capacidadeMax;
      ocupadosAtuais = slotData.ocupados || 0;
    } else {
      capacidadeAtual = slotReferencia
        ? slotReferencia.capacidadeMax
        : (dados.capacidadeManual || CAPACIDADE_PADRAO_FORA_DO_PADRAO);
      ocupadosAtuais = 0;
    }

    let novosOcupados = ocupadosAtuais + 1;

    if (novosOcupados > capacidadeAtual) {
      if (!forcarAlemDaCapacidade) {
        throw new Error(
          `Sem vaga disponível neste horário (${ocupadosAtuais}/${capacidadeAtual} já ocupado(s)). ` +
          `Use opcoes.forcarAlemDaCapacidade=true para registrar mesmo assim.`
        );
      }
      // Eleva a capacidade para acomodar o registro forçado, mantendo
      // válida a invariante ocupados <= capacidadeMax.
      capacidadeAtual = novosOcupados;
      capacidadeForcada = true;
    }

    capacidadeMax = capacidadeAtual;
    ocupados = novosOcupados;

    // Cria (se necessário) ou atualiza a vaga com a nova ocupação —
    // mesmo padrão "lazy" usado no fluxo da Transportadora.
    transaction.set(slotRef, {
      data: dataAgendada,
      horaInicio,
      horaFim,
      capacidadeMax,
      ativo: true,
      ocupados
    }, { merge: true });

    // Salva o agendamento já como "Aprovado" — não passa pelo estado
    // "Pendente" porque foi a própria Logística/Admin quem o registrou.
    transaction.set(bookingRef, {
      usuarioId: transportadoraCadastrada ? transportadoraCadastrada.uid : null,
      transportadoraCadastrada: !!transportadoraCadastrada,
      empresa: String(dados.empresa).trim(),
      tipoProcessoId: dados.tipoProcessoId,
      dataAgendada,
      horaInicio,
      horaFim,
      placaCavalo: String(dados.placaCavalo).trim().toUpperCase(),
      placaCarreta: dados.placaCarreta ? String(dados.placaCarreta).trim().toUpperCase() : "",
      motorista: String(dados.motorista).trim(),
      observacoes: dados.observacoes ? String(dados.observacoes).trim() : "",
      status: STATUS.APROVADO,
      tipoAgendamento: TIPO_AGENDAMENTO.OPERACIONAL,
      vagaLiberada: false, // controle interno: vira true quando a vaga é de fato liberada (recusa/cancelamento/expiração)
      criadoEm: serverTimestamp(),
      criadoPor: usuarioLogado.uid, // quem da Logística/Admin registrou (diferente de usuarioId quando é transportadora cadastrada)
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });

  // Log de auditoria imutável (fora da transação, mesmo padrão já usado
  // no restante do sistema — não desfaz o agendamento se falhar aqui).
  // Registra duas ações em sequência: "Solicitou" (a criação do
  // registro em si) e "Aprovou" (porque nasce já aprovado), preservando
  // o mesmo vocabulário de auditoria (`acao`) já usado em todo o resto
  // do sistema, sem precisar de um valor novo só para este caso.
  try {
    await addDoc(collection(db, "auditLogs"), {
      bookingId: bookingRef.id,
      usuarioId: usuarioLogado.uid,
      acao: "Solicitou",
      dataHora: serverTimestamp()
    });
    await addDoc(collection(db, "auditLogs"), {
      bookingId: bookingRef.id,
      usuarioId: usuarioLogado.uid,
      acao: "Aprovou",
      dataHora: serverTimestamp()
    });
  } catch (errAudit) {
    console.error("Erro ao registrar log de auditoria do agendamento operacional:", errAudit);
  }

  return { bookingId: bookingRef.id, slotId, capacidadeMax, ocupados, capacidadeForcada };
}
