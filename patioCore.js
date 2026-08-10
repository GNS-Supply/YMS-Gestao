// =====================================================================
// patioCore.js — Núcleo do Sistema de Agendamento de Pátio
//
// Arquivo unificado que reúne os módulos que antes viviam separados em:
//   - bookingSchema.js          (status, máquina de estados, check-in/out)
//   - disponibilidade.js        (motor de cálculo de horários/vagas)
//   - agendamentoOperacional.js (criação de agendamento direto pela Logística)
//   - kpiMetrics.js             (cálculo de KPIs e métricas operacionais)
//
// Foram unificados porque tinham dependência forte entre si (ex:
// agendamentoOperacional.js importava de disponibilidade.js E de
// bookingSchema.js; kpiMetrics.js importava de bookingSchema.js). Juntos
// num arquivo só, ficam mais fáceis de manter sem duplicar lógica nem
// gerenciar 4 imports cruzados. NENHUMA função/constante mudou de
// comportamento — só a organização física dos arquivos.
//
// Nenhum destes módulos faz chamada ao Firestore que grave dados fora
// de uma Transaction quando envolve concorrência de vagas (ver seção
// "AGENDAMENTO OPERACIONAL" abaixo) — segue o mesmo princípio já usado
// no fluxo da Transportadora: nunca dar `add()`/`update()` direto numa
// vaga compartilhada sem transação, para não perder reserva quando dois
// usuários mexem ao mesmo tempo (condição de corrida).
//
// Import único nas telas que usam este núcleo, por exemplo:
//   import { STATUS, buscarSlotsVirtuaisDoDia, criarAgendamentoOperacional,
//            calcularKPIs } from "./patioCore.js";
// =====================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  query,
  where,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* #######################################################################
   PARTE 1 — BOOKING SCHEMA
   Status, máquina de estados de transição, tipos de agendamento,
   pontualidade de check-in, check-out e tempo de permanência.

   Fluxo:
     Pendente → Aprovado → Em Pátio → Concluído
                       ↘ No-Show
     Pendente → Recusado / Expirado / Cancelado

   Campos do documento `bookings/{id}`:
     usuarioId, empresa, tipoProcessoId, dataAgendada, horaInicio,
     placaCavalo, placaCarreta, motorista, observacoes, status, criadoEm,
     atualizadoEm, atualizadoPor, vagaLiberada, horaEntrada, horaSaida,
     tipoAgendamento: "Antecipado" | "Portaria/Encaixe" | "Operacional"
     checkIn:  { dataHora: Timestamp, pontualidade, dadosConferidos }
     checkOut: { dataHora: Timestamp, notaFiscal }
   ####################################################################### */

// ---------------------- STATUS ----------------------

export const STATUS = {
  PENDENTE: "Pendente",
  APROVADO: "Aprovado",
  RECUSADO: "Recusado",
  EXPIRADO: "Expirado",
  CANCELADO: "Cancelado",
  EM_PATIO: "Em Pátio",
  CONCLUIDO: "Concluído",
  NO_SHOW: "No-Show"
};

export const TODOS_STATUS = Object.values(STATUS);

// Status que já existiam antes da jornada completa de pátio (útil para
// telas/relatórios que ainda não foram migrados).
export const STATUS_LEGADO = [
  STATUS.PENDENTE, STATUS.APROVADO, STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO
];
export const STATUS_NOVO = [STATUS.EM_PATIO, STATUS.CONCLUIDO, STATUS.NO_SHOW];

// Estados terminais: nenhuma transição sai deles.
export const STATUS_FINAIS = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.CONCLUIDO, STATUS.NO_SHOW
];

// Enquanto o booking está em um desses status, ele continua contando
// como vaga ocupada em timeSlots.ocupados (não foi liberada ainda).
export const STATUS_OCUPA_VAGA = [
  STATUS.PENDENTE, STATUS.APROVADO, STATUS.EM_PATIO, STATUS.CONCLUIDO
];

// Ao entrar em qualquer um destes status, a vaga em timeSlots.ocupados
// deve ser liberada (decrementada).
export const STATUS_LIBERA_VAGA = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.NO_SHOW
];

// ---------------------- MÁQUINA DE ESTADOS ----------------------
// Serve tanto para validar no cliente antes de escrever quanto como
// documentação viva do fluxo (espelha as Firestore Rules).

export const TRANSICOES_VALIDAS = {
  [STATUS.PENDENTE]: [STATUS.APROVADO, STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO],
  [STATUS.APROVADO]: [STATUS.EM_PATIO, STATUS.CANCELADO, STATUS.NO_SHOW],
  [STATUS.EM_PATIO]: [STATUS.CONCLUIDO],
  [STATUS.RECUSADO]: [],
  [STATUS.EXPIRADO]: [],
  [STATUS.CANCELADO]: [],
  [STATUS.CONCLUIDO]: [],
  [STATUS.NO_SHOW]: []
};

/**
 * @param {string} statusAtual
 * @param {string} novoStatus
 * @returns {boolean} true se a transição statusAtual -> novoStatus é permitida
 */
export function transicaoValida(statusAtual, novoStatus) {
  return (TRANSICOES_VALIDAS[statusAtual] || []).includes(novoStatus);
}

/** @returns {boolean} true se o status não tem mais nenhuma transição possível */
export function isStatusFinal(status) {
  return STATUS_FINAIS.includes(status);
}

/** @returns {boolean} true se o booking ainda deve contar como vaga ocupada */
export function ocupaVaga(status) {
  return STATUS_OCUPA_VAGA.includes(status);
}

/** @returns {boolean} true se essa transição deve liberar a vaga em timeSlots */
export function deveLiberarVaga(statusAtual, novoStatus) {
  return !STATUS_LIBERA_VAGA.includes(statusAtual) && STATUS_LIBERA_VAGA.includes(novoStatus);
}

// ---------------------- TIPO DE AGENDAMENTO ----------------------

export const TIPO_AGENDAMENTO = {
  ANTECIPADO: "Antecipado",
  PORTARIA: "Portaria/Encaixe",
  // Agendamento criado diretamente pela Logística/Admin (ver
  // criarAgendamentoOperacional), já nascendo como "Aprovado" — não
  // passa pelo fluxo de solicitação/aprovação da Transportadora.
  OPERACIONAL: "Operacional"
};

export const TODOS_TIPOS_AGENDAMENTO = Object.values(TIPO_AGENDAMENTO);

// ---------------------- CHECK-IN — PONTUALIDADE ----------------------

export const PONTUALIDADE = {
  PONTUAL: "Pontual",
  ADIANTADO: "Adiantado",
  ATRASADO: "Atrasado"
};

// Janela em minutos ao redor do horário agendado considerada "Pontual".
export const TOLERANCIA_PONTUALIDADE_MIN = 10;

/**
 * Classifica a pontualidade do check-in comparando o horário agendado
 * com o horário real de chegada.
 *
 * @param {string} horaAgendada - "HH:MM" (booking.horaInicio)
 * @param {Date} dataHoraCheckIn - horário real de chegada
 * @param {number} [toleranciaMin] - janela em minutos considerada "Pontual"
 * @returns {"Pontual"|"Adiantado"|"Atrasado"}
 */
export function calcularPontualidade(horaAgendada, dataHoraCheckIn, toleranciaMin = TOLERANCIA_PONTUALIDADE_MIN) {
  const minutosAgendado = horaParaMinutos(horaAgendada);
  const minutosCheckIn = dataHoraCheckIn.getHours() * 60 + dataHoraCheckIn.getMinutes();
  const diferenca = minutosCheckIn - minutosAgendado;

  if (Math.abs(diferenca) <= toleranciaMin) return PONTUALIDADE.PONTUAL;
  return diferenca < 0 ? PONTUALIDADE.ADIANTADO : PONTUALIDADE.ATRASADO;
}

/**
 * Monta o objeto `checkIn` a ser gravado no booking.
 *
 * IMPORTANTE: `dataHoraLocal` aqui é só referência para calcular a
 * pontualidade no cliente antes de enviar. Na escrita real ao
 * Firestore, o campo `dataHora` do payload deve usar serverTimestamp()
 * (nunca o Date do cliente).
 *
 * @param {string} horaAgendada - booking.horaInicio
 * @param {Date} [dataHoraCheckIn] - default: agora
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.dadosConferidos=false]
 * @param {number} [opcoes.toleranciaMin]
 * @returns {{dataHoraLocal: Date, pontualidade: string, dadosConferidos: boolean}}
 */
export function montarCheckIn(horaAgendada, dataHoraCheckIn = new Date(), opcoes = {}) {
  const { dadosConferidos = false, toleranciaMin } = opcoes;
  return {
    dataHoraLocal: dataHoraCheckIn,
    pontualidade: calcularPontualidade(horaAgendada, dataHoraCheckIn, toleranciaMin),
    dadosConferidos: !!dadosConferidos
  };
}

// ---------------------- CHECK-OUT + TEMPO DE PERMANÊNCIA ----------------------

/**
 * Monta o objeto `checkOut` a ser gravado no booking.
 * Mesma observação do montarCheckIn: `dataHoraLocal` é só referência;
 * grave `dataHora` com serverTimestamp() na escrita real.
 *
 * @param {string} [notaFiscal]
 * @param {Date} [dataHoraCheckOut] - default: agora
 * @returns {{dataHoraLocal: Date, notaFiscal: string}}
 */
export function montarCheckOut(notaFiscal = "", dataHoraCheckOut = new Date()) {
  return {
    dataHoraLocal: dataHoraCheckOut,
    notaFiscal: String(notaFiscal || "").trim()
  };
}

/**
 * Converte um valor de data vindo do Firestore (Timestamp com .toDate(),
 * já um Date, ou string ISO) para um objeto Date puro.
 * @param {*} valor
 * @returns {Date|null}
 */
export function paraDate(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === "function") return valor.toDate(); // Firestore Timestamp
  if (valor instanceof Date) return valor;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Calcula o tempo de permanência em minutos a partir dos horários de
 * check-in e check-out (aceita Timestamp do Firestore, Date ou string).
 *
 * @param {*} checkInDataHora
 * @param {*} checkOutDataHora
 * @returns {number|null} minutos inteiros, ou null se algum horário for inválido/negativo
 */
export function calcularTempoPermanenciaMinutos(checkInDataHora, checkOutDataHora) {
  const entrada = paraDate(checkInDataHora);
  const saida = paraDate(checkOutDataHora);
  if (!entrada || !saida) return null;

  const diffMin = Math.round((saida.getTime() - entrada.getTime()) / 60000);
  return diffMin >= 0 ? diffMin : null;
}

/**
 * Formata minutos em texto legível ("1h20min" / "45min").
 * @param {number} minutos
 * @returns {string}
 */
export function formatarPermanencia(minutos) {
  if (minutos === null || minutos === undefined || isNaN(minutos)) return "-";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${m}min`;
}

// ---------------------- VALIDAÇÃO DE FORMA ----------------------
// (uso no cliente antes de gravar — não substitui as Firestore Rules,
// que continuam sendo a fonte de verdade)

/**
 * Validação de forma do payload de checkIn antes de enviar ao Firestore.
 * @param {object} checkIn
 * @returns {boolean}
 */
export function checkInValido(checkIn) {
  return !!checkIn
    && Object.values(PONTUALIDADE).includes(checkIn.pontualidade)
    && typeof checkIn.dadosConferidos === "boolean";
}

/**
 * Validação de forma do payload de checkOut antes de enviar ao Firestore.
 * @param {object} checkOut
 * @returns {boolean}
 */
export function checkOutValido(checkOut) {
  return !!checkOut && typeof checkOut.notaFiscal === "string";
}

/* #######################################################################
   PARTE 2 — DISPONIBILIDADE
   Motor de cálculo de horários/vagas disponíveis para uma data
   qualquer, sem precisar "gerar" janelas manualmente no calendário.
   Qualquer data futura já é automaticamente calculada combinando 3
   camadas, em ordem de prioridade crescente:

     1) timeSlotRules       -> Regra Padrão de Atendimento (recorrente
                                por dia da semana).
     2) timeSlotExceptions  -> Exceções recorrentes por dia da semana,
                                que sobrescrevem a regra padrão.
     3) timeSlots           -> Ajuste manual pontual para UMA data
                                específica (prioridade máxima). Também
                                é onde a ocupação real fica registrada,
                                criado de forma "preguiçosa" (lazy) no
                                momento da primeira reserva do horário.
   ####################################################################### */

export function horaParaMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutosParaHora(min) {
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// ID determinístico do documento em timeSlots para uma data + horário.
export function idSlotHorario(dataStr, horaInicio) {
  return `${dataStr}_${horaInicio.replace(":", "-")}`;
}

// Converte um objeto { horaInicio, horaFim } em uma lista de blocos de 1h
// (representados pelo minuto de início, 0-1439), tratando corretamente
// intervalos que atravessam a meia-noite (ex: 06:00 às 00:00).
export function calcularBlocosHorario(obj) {
  const inicioMin = horaParaMinutos(obj.horaInicio);
  let fimMin = horaParaMinutos(obj.horaFim);
  if (fimMin <= inicioMin) fimMin += 24 * 60;
  const blocos = [];
  for (let m = inicioMin; m < fimMin; m += 60) {
    blocos.push(m % (24 * 60));
  }
  return blocos;
}

function diaSemanaDaData(dataStr) {
  const [ano, mes, dia] = dataStr.split("-").map(Number);
  return new Date(ano, mes - 1, dia).getDay(); // 0=domingo ... 6=sábado
}

/**
 * Calcula os horários "virtuais" de uma data específica, combinando
 * Regra Padrão + Exceções + Ajustes Manuais.
 *
 * @param {Firestore} db
 * @param {string} dataStr - formato "AAAA-MM-DD"
 * @param {object} [opcoes]
 *   - incluirFechados (default false): se true, mantém no resultado os
 *     horários fechados manualmente para aquela data (flag `fechado: true`)
 *     em vez de omiti-los. Útil na tela de gestão (para poder reabrir);
 *     na tela de agendamento da transportadora deve ficar false.
 * @returns {Promise<Array<{
 *   horaInicio: string, horaFim: string, capacidadeMax: number,
 *   ocupados: number, origem: "regra"|"excecao"|"manual", fechado: boolean,
 *   temAjusteManual: boolean, capacidadePadraoAtual: number|null,
 *   divergeDoPadrao: boolean
 * }>>}
 *
 * IMPORTANTE sobre "divergeDoPadrao": o documento em `timeSlots` (camada 3)
 * tem prioridade máxima e, uma vez criado, ele NÃO é recalculado
 * automaticamente se a Regra Padrão ou uma Exceção mudar depois (é o
 * que garante que reservas já feitas não mudem de capacidade sozinhas).
 * `capacidadePadraoAtual` e `divergeDoPadrao` existem para deixar isso
 * visível na tela em vez de parecer que a Exceção "não funcionou".
 */
export async function buscarSlotsVirtuaisDoDia(db, dataStr, opcoes = {}) {
  const { incluirFechados = false } = opcoes;
  const diaSemana = diaSemanaDaData(dataStr);
  const mapa = {}; // horaInicio -> { capacidadeMax, origem, fechado? }

  // 1) Regra Padrão de Atendimento
  const snapRegras = await getDocs(query(collection(db, "timeSlotRules"), where("ativo", "==", true)));
  snapRegras.docs.forEach(d => {
    const r = d.data();
    if (!(r.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(r).forEach(min => {
      mapa[minutosParaHora(min)] = { capacidadeMax: r.capacidadePorHora, origem: "regra" };
    });
  });

  // 2) Exceções recorrentes (sobrescrevem a regra padrão)
  const snapExc = await getDocs(query(collection(db, "timeSlotExceptions"), where("ativo", "==", true)));
  snapExc.docs.forEach(d => {
    const ex = d.data();
    if (!(ex.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(ex).forEach(min => {
      const hora = minutosParaHora(min);
      if (Number(ex.capacidadePorHora) <= 0) {
        // 0 = sem atendimento nesse intervalo/dia
        delete mapa[hora];
      } else {
        mapa[hora] = { capacidadeMax: ex.capacidadePorHora, origem: "excecao" };
      }
    });
  });

  // Snapshot do que a Regra + Exceções calculam para hoje, ANTES de
  // aplicar qualquer ajuste manual — usado só para detectar divergência.
  const padraoAtual = {};
  Object.keys(mapa).forEach(hora => { padraoAtual[hora] = mapa[hora].capacidadeMax; });

  // 3) Ajustes manuais pontuais para esta data específica (prioridade máxima)
  //    Também é onde fica registrada a ocupação real já reservada.
  const snapManual = await getDocs(query(collection(db, "timeSlots"), where("data", "==", dataStr)));
  const manuais = {};
  snapManual.docs.forEach(d => { manuais[d.data().horaInicio] = { id: d.id, ...d.data() }; });

  Object.keys(manuais).forEach(hora => {
    const m = manuais[hora];
    if (m.ativo === false) {
      if (incluirFechados) {
        mapa[hora] = { capacidadeMax: m.capacidadeMax || 0, origem: "manual", fechado: true };
      } else {
        delete mapa[hora];
      }
    } else {
      mapa[hora] = { capacidadeMax: m.capacidadeMax, origem: "manual", fechado: false };
    }
  });

  return Object.keys(mapa).sort().map(hora => {
    const info = mapa[hora];
    const manual = manuais[hora];
    // undefined = a Regra/Exceção não atende esse horário hoje (ex: foi removido por uma exceção nova)
    const capacidadePadraoAtual = Object.prototype.hasOwnProperty.call(padraoAtual, hora) ? padraoAtual[hora] : null;
    const divergeDoPadrao = !!manual && !info.fechado
      && capacidadePadraoAtual !== info.capacidadeMax;
    return {
      horaInicio: hora,
      horaFim: minutosParaHora((horaParaMinutos(hora) + 60) % (24 * 60)),
      capacidadeMax: info.capacidadeMax,
      ocupados: manual ? (manual.ocupados || 0) : 0,
      origem: info.origem,
      fechado: !!info.fechado,
      temAjusteManual: !!manual,
      capacidadePadraoAtual,
      divergeDoPadrao
    };
  });
}

/**
 * Wrapper de conveniência sobre `buscarSlotsVirtuaisDoDia` para telas que
 * precisam apenas saber "quantas vagas restam" por horário (ex: painel de
 * ocupação da Logística, dropdown de Novo Agendamento Operacional), sem
 * lidar diretamente com os campos internos (capacidadeMax/ocupados
 * separados).
 *
 * Adiciona o campo `vagasRestantes` (nunca negativo) a cada slot
 * retornado por `buscarSlotsVirtuaisDoDia`, mantendo todos os demais
 * campos originais.
 *
 * @param {Firestore} db
 * @param {string} dataStr - formato "AAAA-MM-DD"
 * @param {object} [opcoes]
 *   - incluirFechados (default false): repassado direto para
 *     `buscarSlotsVirtuaisDoDia`.
 * @returns {Promise<Array<{
 *   horaInicio: string, horaFim: string, capacidadeMax: number,
 *   ocupados: number, vagasRestantes: number, origem: string, fechado: boolean,
 *   temAjusteManual: boolean, capacidadePadraoAtual: number|null,
 *   divergeDoPadrao: boolean
 * }>>}
 */
export async function obterHorariosDisponiveis(db, dataStr, opcoes = {}) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataStr, opcoes);
  return slots.map(slot => ({
    ...slot,
    vagasRestantes: Math.max(0, (slot.capacidadeMax || 0) - (slot.ocupados || 0))
  }));
}

/* #######################################################################
   PARTE 3 — AGENDAMENTO OPERACIONAL
   Função core para a Logística/Admin criarem um agendamento DIRETO no
   sistema (sem passar pelo fluxo Pendente -> Aprovado da Transportadora).
   Cobre dois casos de uso:

     1) Empresa parceira JÁ CADASTRADA (tipo=1, aprovada) — a Logística
        escolhe a transportadora num dropdown e o agendamento fica
        vinculado ao usuarioId dela normalmente.
     2) Parceiro pontual / avulso (não tem login no sistema) — a
        Logística digita o nome da empresa na hora; o agendamento é
        salvo com usuarioId = null.

   Em ambos os casos o booking já nasce com status "Aprovado" e
   tipoAgendamento: "Operacional", e um log imutável é gravado em
   auditLogs deixando claro que foi a própria Logística/Admin quem criou
   o registro.

   Reaproveita a MESMA lógica de concorrência/atomicidade já usada no
   fluxo da Transportadora: uma Firestore Transaction sobre o documento
   em `timeSlots`, criando-o de forma "lazy" se ainda não existir,
   incrementando `ocupados` com segurança mesmo se dois cliques
   acontecerem ao mesmo tempo (protege contra conflito de dois usuários
   agendando o mesmo horário simultaneamente).

   -----------------------------------------------------------------
   NOTA SOBRE AS FIRESTORE RULES: `firestore.rules` já libera este
   caso desde a revisão que adicionou `novoAgendamentoOperacionalValido()`
   (match /bookings/{bookingId} -> allow create). Ela aceita um
   documento criado por Logística/Admin com usuarioId de OUTRA pessoa
   (ou null) e status "Aprovado" + tipoAgendamento "Operacional",
   exigindo em troca `criadoPor == request.auth.uid` e as validações de
   forma usuais (empresa, tipoProcessoId existente, placaCavalo,
   motorista, data/hora válidas). Confirme que essa versão das Rules
   está de fato publicada no Console antes de usar esta função em
   produção — o comportamento antigo (rejeição) valia só para a versão
   anterior das Rules.
   ----------------------------------------------------------------- */

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
 * próprio documento em `timeSlots`.
 *
 * @returns {Promise<object|null>} o slot inteiro (tem capacidadeMax e
 *   fechado), ou null se o horário estiver fora de qualquer
 *   Regra/Exceção vigente
 */
async function buscarCapacidadeReferencia(db, dataAgendada, horaInicio) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataAgendada, { incluirFechados: true });
  const slot = slots.find(s => s.horaInicio === horaInicio);
  return slot ? slot : null;
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
 * @param {string} dados.empresa - nome da empresa (obrigatório mesmo se transportadoraId for informado)
 * @param {string} dados.tipoProcessoId
 * @param {string} dados.dataAgendada - "AAAA-MM-DD"
 * @param {string} dados.horaInicio - "HH:MM"
 * @param {string} dados.placaCavalo
 * @param {string} [dados.placaCarreta]
 * @param {string} dados.motorista
 * @param {string} [dados.observacoes]
 * @param {number} [dados.capacidadeManual] - usada só se o horário estiver fora de qualquer
 *   Regra Padrão/Exceção vigente e o timeSlot ainda não existir
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.forcarAlemDaCapacidade=false] - se true, permite gravar mesmo sem vaga
 *   disponível, elevando `capacidadeMax` do timeSlot para acomodar o novo registro
 * @param {boolean} [opcoes.ignorarFechado=false] - se true, permite agendar mesmo num horário
 *   fechado manualmente para aquela data específica
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
  //    tipo=1 e está aprovada.
  const transportadoraCadastrada = await buscarTransportadoraCadastrada(db, dados.transportadoraId);

  const dataAgendada = dados.dataAgendada;
  const horaInicio = dados.horaInicio;
  const horaFim = minutosParaHora((horaParaMinutos(horaInicio) + 60) % (24 * 60));

  // 2) Capacidade de referência (Regra/Exceção/Manual já existente),
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

  // Transação atômica: garante que dois cliques/usuários simultâneos não
  // ultrapassem a capacidade nem sobrescrevam a contagem um do outro.
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
      capacidadeAtual = novosOcupados;
      capacidadeForcada = true;
    }

    capacidadeMax = capacidadeAtual;
    ocupados = novosOcupados;

    transaction.set(slotRef, {
      data: dataAgendada,
      horaInicio,
      horaFim,
      capacidadeMax,
      ativo: true,
      ocupados
    }, { merge: true });

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
      vagaLiberada: false,
      criadoEm: serverTimestamp(),
      criadoPor: usuarioLogado.uid,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });

  // Log de auditoria imutável (fora da transação — não desfaz o
  // agendamento se falhar aqui).
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

/* #######################################################################
   PARTE 4 — KPI METRICS
   Motor de Cálculo de KPIs e Métricas Operacionais.
   ####################################################################### */

/**
 * Filtra a lista de agendamentos com base em período e transportadora.
 * @param {Array} bookings - Lista de agendamentos do Firestore
 * @param {string} dataInicio - Data inicial no formato "YYYY-MM-DD"
 * @param {string} dataFim - Data final no formato "YYYY-MM-DD"
 * @param {string} empresa - Nome da empresa/transportadora ("todas" para sem filtro)
 */
export function filtrarBookings(bookings, dataInicio, dataFim, empresa = "todas") {
  return bookings.filter(b => {
    // Filtro de Data (dataAgendada é YYYY-MM-DD)
    if (dataInicio && b.dataAgendada < dataInicio) return false;
    if (dataFim && b.dataAgendada > dataFim) return false;

    // Filtro de Empresa
    if (empresa && empresa !== "todas" && b.empresa !== empresa) return false;

    return true;
  });
}

/**
 * Calcula o consolidado das métricas de desempenho.
 * @param {Array} bookingsFiltrados
 * @returns {Object} Dados consolidados para os cards e tabelas
 */
export function calcularKPIs(bookingsFiltrados) {
  const totalGeral = bookingsFiltrados.length;

  // 1. Agendamentos válidos para taxa de No-Show (Concluídos, Em Pátio, Aprovados, No-Show)
  const previstos = bookingsFiltrados.filter(b =>
    [STATUS.CONCLUIDO, STATUS.EM_PATIO, STATUS.APROVADO, STATUS.NO_SHOW].includes(b.status)
  );
  const totalPrevistos = previstos.length;
  const totalNoShow = previstos.filter(b => b.status === STATUS.NO_SHOW).length;
  const taxaNoShow = totalPrevistos > 0 ? ((totalNoShow / totalPrevistos) * 100).toFixed(1) : "0.0";

  // 2. Análise de Pontualidade (somente para quem realizou Check-in)
  const comCheckIn = bookingsFiltrados.filter(b => b.checkIn && b.checkIn.pontualidade);
  const totalCheckIns = comCheckIn.length;

  let noHorario = 0;
  let antecipado = 0;
  let atrasado = 0;

  comCheckIn.forEach(b => {
    const p = b.checkIn.pontualidade;
    if (p === PONTUALIDADE.PONTUAL) noHorario++;
    else if (p === PONTUALIDADE.ADIANTADO) antecipado++;
    else if (p === PONTUALIDADE.ATRASADO) atrasado++;
  });

  const pctNoHorario = totalCheckIns > 0 ? ((noHorario / totalCheckIns) * 100).toFixed(1) : "0.0";
  const pctAntecipado = totalCheckIns > 0 ? ((antecipado / totalCheckIns) * 100).toFixed(1) : "0.0";
  const pctAtrasado = totalCheckIns > 0 ? ((atrasado / totalCheckIns) * 100).toFixed(1) : "0.0";

  // 3. Agendamento Prévio vs Encaixes
  const totalEncaixes = bookingsFiltrados.filter(b => b.tipoAgendamento === TIPO_AGENDAMENTO.PORTARIA).length;
  const totalPrevio = totalGeral - totalEncaixes;
  const pctPrevio = totalGeral > 0 ? ((totalPrevio / totalGeral) * 100).toFixed(1) : "0.0";
  const pctEncaixe = totalGeral > 0 ? ((totalEncaixes / totalGeral) * 100).toFixed(1) : "0.0";

  // 4. Tempo Médio de Permanência (Dwell Time - Somente Concluídos)
  const concluidos = bookingsFiltrados.filter(b =>
    b.status === STATUS.CONCLUIDO && b.checkOut?.permanenciaMinutos !== undefined
  );

  const somaMinutos = concluidos.reduce((acc, b) => acc + (b.checkOut.permanenciaMinutos || 0), 0);
  const mediaMinutos = concluidos.length > 0 ? Math.round(somaMinutos / concluidos.length) : 0;
  const dwellTimeFormatado = formatarPermanencia(mediaMinutos);

  // 5. Divergência de Dados (Placas ou Motoristas informados no Check-in diferentes dos cadastrados)
  let totalDivergencias = 0;
  comCheckIn.forEach(b => {
    if (b.checkIn?.dadosConferidos === true && b.checkIn?.divergente === true) {
      totalDivergencias++;
    }
  });

  return {
    totalGeral,
    totalPrevistos,
    totalNoShow,
    taxaNoShow,
    totalCheckIns,
    pontualidade: {
      noHorario,
      antecipado,
      atrasado,
      pctNoHorario,
      pctAntecipado,
      pctAtrasado
    },
    modalidade: {
      totalPrevio,
      totalEncaixes,
      pctPrevio,
      pctEncaixe
    },
    dwellTime: {
      mediaMinutos,
      formatado: dwellTimeFormatado,
      totalAtendidos: concluidos.length
    },
    totalDivergencias
  };
}

/* #######################################################################
   PARTE 5 — LIBERAÇÃO DE VAGA AO ENCERRAR UM AGENDAMENTO
   =================================================================
   BUG CORRIGIDO NESTA SEÇÃO: até aqui, `timeSlots.ocupados` só era
   INCREMENTADO (na criação do booking). Recusar, expirar, cancelar ou
   marcar No-Show trocava o `status` do booking mas nunca decrementava
   a ocupação — a vaga ficava "presa" para sempre, mesmo sem ninguém
   usando ela de fato. As duas funções abaixo resolvem isso.
   ####################################################################### */

/**
 * Muda o status de um booking, liberando a vaga em `timeSlots`
 * automaticamente quando a transição for uma das que libera vaga (ver
 * `deveLiberarVaga`/`STATUS_LIBERA_VAGA`: Recusado, Expirado, Cancelado,
 * No-Show). Tudo dentro de uma única Firestore Transaction: ou o novo
 * status do booking E a liberação da vaga são gravados juntos, ou nada
 * é gravado (evita, por exemplo, recusar um agendamento e a vaga
 * continuar presa por causa de uma falha no meio do caminho).
 *
 * Lê o status atual do booking de dentro da própria transação (não
 * confia no objeto `booking` passado pelo chamador, que pode estar
 * desatualizado) — protege contra dois cliques/usuários simultâneos
 * tentando mudar o mesmo agendamento.
 *
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado - Logística/Admin autenticado fazendo a alteração
 * @param {{id:string}} booking - precisa ao menos do `id`; os demais campos são
 *   sempre relidos do servidor dentro da transação
 * @param {string} novoStatus - um dos valores de STATUS
 * @returns {Promise<{vagaLiberada: boolean}>}
 */
export async function mudarStatusBooking(db, usuarioLogado, booking, novoStatus) {
  if (!usuarioLogado || !usuarioLogado.uid) {
    throw new Error("Usuário não identificado.");
  }
  if (!booking || !booking.id) {
    throw new Error("Agendamento não informado.");
  }

  const bookingRef = doc(db, "bookings", booking.id);
  let vagaFoiLiberada = false;

  await runTransaction(db, async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists()) {
      throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    }
    const dadosAtuais = bookingSnap.data();
    const statusAtual = dadosAtuais.status;

    if (!transicaoValida(statusAtual, novoStatus)) {
      throw new Error(
        `Não é possível mudar de "${statusAtual}" para "${novoStatus}" — outra pessoa pode já ter atualizado este agendamento. Atualize a lista e tente novamente.`
      );
    }

    const precisaLiberarVaga = deveLiberarVaga(statusAtual, novoStatus) && dadosAtuais.vagaLiberada !== true;

    // Toda leitura precisa acontecer antes de qualquer escrita numa
    // Firestore Transaction — por isso o get() do timeSlot vem aqui,
    // antes de montar os writes abaixo.
    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const payloadBooking = {
      status: novoStatus,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      if (slotSnap && slotSnap.exists()) {
        const slotData = slotSnap.data();
        const ocupadosAtuais = slotData.ocupados || 0;
        // Só decrementa se ainda houver o que liberar — nunca deixa
        // `ocupados` ficar negativo (violaria camposValidos() nas Rules).
        if (ocupadosAtuais > 0) {
          transaction.set(slotSnap.ref, { ...slotData, ocupados: ocupadosAtuais - 1 }, { merge: true });
        }
      }
      payloadBooking.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payloadBooking);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

/**
 * Libera a vaga de UM booking que já está em status terminal que
 * libera vaga, SEM mudar o status em si (usado só pela varredura de
 * cancelamentos — o status "Cancelado" já foi gravado antes, pela
 * própria Transportadora).
 * @private
 */
async function liberarVagaSemMudarStatus(db, usuarioLogado, booking) {
  const bookingRef = doc(db, "bookings", booking.id);
  const slotRef = doc(db, "timeSlots", idSlotHorario(booking.dataAgendada, booking.horaInicio));

  await runTransaction(db, async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists()) return;
    if (bookingSnap.data().vagaLiberada === true) return; // já foi liberada (outra aba, outra pessoa)

    const slotSnap = await transaction.get(slotRef);

    if (slotSnap.exists()) {
      const slotData = slotSnap.data();
      const ocupadosAtuais = slotData.ocupados || 0;
      if (ocupadosAtuais > 0) {
        transaction.set(slotRef, { ...slotData, ocupados: ocupadosAtuais - 1 }, { merge: true });
      }
    }

    transaction.update(bookingRef, {
      vagaLiberada: true,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

/**
 * Varredura: busca todos os bookings "Cancelado" que ainda não tiveram
 * a vaga liberada (`vagaLiberada !== true`) — cenário típico é a
 * própria Transportadora cancelando a reserva dela, o que as Rules só
 * deixam mudar o `status` (ela nunca decrementa `timeSlots` diretamente,
 * só Logística/Admin podem, com segurança/atomicidade). Pensada para
 * rodar automaticamente ao abrir o Painel de Logística.
 *
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado - Logística/Admin autenticado
 * @returns {Promise<number>} quantidade de vagas liberadas nesta varredura
 */
export async function liberarVagasCanceladasPelaTransportadora(db, usuarioLogado) {
  const snap = await getDocs(query(collection(db, "bookings"), where("status", "==", STATUS.CANCELADO)));

  // Sem orderBy() de propósito (mesmo motivo já documentado em outras
  // consultas deste projeto): igualdade simples usa o índice automático
  // de campo único, sem depender de índice composto.
  const pendentesDeLiberacao = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.vagaLiberada !== true);

  let totalLiberadas = 0;
  for (const booking of pendentesDeLiberacao) {
    try {
      await liberarVagaSemMudarStatus(db, usuarioLogado, booking);
      totalLiberadas++;
    } catch (err) {
      console.error(`Erro ao liberar vaga do agendamento cancelado ${booking.id}:`, err);
    }
  }

  return totalLiberadas;
}
