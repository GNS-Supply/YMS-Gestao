// =====================================================================
// patioCore.js — Núcleo do Sistema de Agendamento de Pátio
//
// Arquivo unificado que reúne os módulos que antes viviam separados em:
//   - bookingSchema.js          (status, máquina de estados, check-in/out)
//   - disponibilidade.js        (motor de cálculo de horários/vagas)
//   - agendamentoOperacional.js (criação de agendamento direto pela Logística)
//   - kpiMetrics.js             (cálculo de KPIs e métricas operacionais)
//
// ETAPA 1 (modelo tridimensional de estados) — RESUMO DA MUDANÇA:
// Até esta revisão, cada booking tinha um único campo `status` (Pendente,
// Aprovado, Recusado, Expirado, Cancelado, Em Pátio, Concluído, No-Show),
// misturando 3 coisas conceitualmente diferentes: "foi autorizado?",
// "o motorista apareceu?" e "está fisicamente no pátio agora?". Isso já
// vinha dando problema (ex: um agendamento "Aprovado" que chegou atrasado
// não tinha como registrar isso sem inventar um status novo).
//
// Esta revisão troca esse único campo por 3 campos INDEPENDENTES no
// documento `bookings/{id}`:
//
//   aprovacaoStatus:      PENDENTE | APROVADO | RECUSADO | EXPIRADO |
//                         CANCELADO | SEM_RESPOSTA   (dimensão administrativa)
//   comparecimentoStatus: null | NAO_COMPARECEU | COMPARECEU |
//                         COMPARECEU_ATRASADO         (dimensão física — só
//                         deixa de ser null quando o motorista é verificado
//                         na Portaria, seja em check-in normal ou em No-Show)
//   operacionalStatus:    SEM_CHECKIN | EM_PATIO | CONCLUIDO
//                         (dimensão de ocupação física do pátio/doca)
//
// O campo antigo `status` (legado) CONTINUA sendo gravado em paralelo,
// sempre derivado das 3 dimensões (ver `derivarStatusLegado`), porque
// `transportadora-dashboard.html` e trechos do próprio `patioCore.js`
// (KPIs, liberação de vaga por varredura) ainda leem só esse campo — a
// instrução desta etapa foi "não alterar HTML/telas ainda", então nenhuma
// tela precisou mudar: quem já lia `status` continua lendo `status`, quem
// já foi escrito esperando as 3 dimensões (logistica-dashboard.html) já
// encontra os campos novos.
//
// Toda mudança em qualquer uma das 3 dimensões é registrada em
// `historicoEstados` (array no próprio booking, sem apagar entradas
// anteriores): { dataHora, dimensaoAlterada, valorAnterior, novoValor,
// usuarioId }. Observação técnica: o Firestore não aceita
// `serverTimestamp()` dentro de um array usado com `arrayUnion` — por
// isso `dataHora` aqui é um `Date` do cliente (só para exibição/auditoria
// leve), diferente de `criadoEm`/`atualizadoEm` do booking, que continuam
// usando `serverTimestamp()` normalmente.
//
// NENHUMA regra automática de No-Show/Expirado/Atraso foi implementada
// nesta etapa (isso fica para depois — ver expirar-pendentes.yml/mjs,
// que já existe separadamente para expiração por tempo). As funções aqui
// só cobrem ações manuais disparadas pela tela (Portaria clicando em
// Check-in/Check-out/No-Show, Logística clicando em Aprovar/Recusar).
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
  runTransaction,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* #######################################################################
   PARTE 1 — BOOKING SCHEMA (MODELO LEGADO — mantido por compatibilidade)
   Status único, máquina de estados de transição, tipos de agendamento,
   pontualidade de check-in, check-out e tempo de permanência.

   Continua existindo porque `transportadora-dashboard.html` lê `a.status`
   diretamente, e várias funções abaixo (KPIs, varredura de vagas
   canceladas) ainda usam esses valores. Ver PARTE 1B logo abaixo para o
   modelo novo (tridimensional), que é a fonte de verdade a partir de
   agora — o campo `status` legado passa a ser sempre DERIVADO das 3
   dimensões novas (nunca mais a origem do dado).

   Campos do documento `bookings/{id}` (modelo atual, pós-Etapa 1):
     usuarioId, empresa, tipoProcessoId, dataAgendada, horaInicio,
     placaCavalo, placaCarreta, motorista, observacoes, criadoEm,
     atualizadoEm, atualizadoPor, vagaLiberada, horaEntrada, horaSaida,
     tipoAgendamento: "Antecipado" | "Portaria/Encaixe" | "Operacional"

     -- Modelo novo (3 dimensões independentes — ver PARTE 1B) --
     aprovacaoStatus, comparecimentoStatus, operacionalStatus,
     historicoEstados: [{ dataHora, dimensaoAlterada, valorAnterior, novoValor, usuarioId }]

     -- Legado, mantido em paralelo, sempre derivado das 3 dimensões --
     status: "Pendente" | "Aprovado" | "Recusado" | "Expirado" |
             "Cancelado" | "Em Pátio" | "Concluído" | "No-Show"

     checkIn:  { dataHora: Timestamp, pontualidade, dadosConferidos, divergente }
     checkOut: { dataHora: Timestamp, notaFiscal, observacoesSaida, permanenciaMinutos }
   ####################################################################### */

// ---------------------- STATUS (LEGADO) ----------------------

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

export const STATUS_LEGADO = [
  STATUS.PENDENTE, STATUS.APROVADO, STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO
];
export const STATUS_NOVO = [STATUS.EM_PATIO, STATUS.CONCLUIDO, STATUS.NO_SHOW];

// Estados terminais (dimensão de aprovação): nenhuma transição sai deles.
export const STATUS_FINAIS = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.CONCLUIDO, STATUS.NO_SHOW
];

// Enquanto o booking está em um desses status (legado), ele continua
// contando como vaga ocupada em timeSlots.ocupados (não foi liberada).
export const STATUS_OCUPA_VAGA = [
  STATUS.PENDENTE, STATUS.APROVADO, STATUS.EM_PATIO, STATUS.CONCLUIDO
];

// Ao entrar em qualquer um destes status (legado), a vaga em
// timeSlots.ocupados deve ser liberada (decrementada).
export const STATUS_LIBERA_VAGA = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.NO_SHOW
];

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

export function transicaoValida(statusAtual, novoStatus) {
  return (TRANSICOES_VALIDAS[statusAtual] || []).includes(novoStatus);
}

export function isStatusFinal(status) {
  return STATUS_FINAIS.includes(status);
}

export function ocupaVaga(status) {
  return STATUS_OCUPA_VAGA.includes(status);
}

export function deveLiberarVaga(statusAtual, novoStatus) {
  return !STATUS_LIBERA_VAGA.includes(statusAtual) && STATUS_LIBERA_VAGA.includes(novoStatus);
}

// ---------------------- TIPO DE AGENDAMENTO ----------------------

export const TIPO_AGENDAMENTO = {
  ANTECIPADO: "Antecipado",
  PORTARIA: "Portaria/Encaixe",
  OPERACIONAL: "Operacional"
};

export const TODOS_TIPOS_AGENDAMENTO = Object.values(TIPO_AGENDAMENTO);

// ---------------------- CHECK-IN — PONTUALIDADE ----------------------

export const PONTUALIDADE = {
  PONTUAL: "Pontual",
  ADIANTADO: "Adiantado",
  ATRASADO: "Atrasado"
};

export const TOLERANCIA_PONTUALIDADE_MIN = 10;

export function calcularPontualidade(horaAgendada, dataHoraCheckIn, toleranciaMin = TOLERANCIA_PONTUALIDADE_MIN) {
  const minutosAgendado = horaParaMinutos(horaAgendada);
  const minutosCheckIn = dataHoraCheckIn.getHours() * 60 + dataHoraCheckIn.getMinutes();
  const diferenca = minutosCheckIn - minutosAgendado;

  if (Math.abs(diferenca) <= toleranciaMin) return PONTUALIDADE.PONTUAL;
  return diferenca < 0 ? PONTUALIDADE.ADIANTADO : PONTUALIDADE.ATRASADO;
}

export function montarCheckIn(horaAgendada, dataHoraCheckIn = new Date(), opcoes = {}) {
  const { dadosConferidos = false, toleranciaMin } = opcoes;
  return {
    dataHoraLocal: dataHoraCheckIn,
    pontualidade: calcularPontualidade(horaAgendada, dataHoraCheckIn, toleranciaMin),
    dadosConferidos: !!dadosConferidos
  };
}

export function montarCheckOut(notaFiscal = "", dataHoraCheckOut = new Date()) {
  return {
    dataHoraLocal: dataHoraCheckOut,
    notaFiscal: String(notaFiscal || "").trim()
  };
}

export function paraDate(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === "function") return valor.toDate();
  if (valor instanceof Date) return valor;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}

export function calcularTempoPermanenciaMinutos(checkInDataHora, checkOutDataHora) {
  const entrada = paraDate(checkInDataHora);
  const saida = paraDate(checkOutDataHora);
  if (!entrada || !saida) return null;

  const diffMin = Math.round((saida.getTime() - entrada.getTime()) / 60000);
  return diffMin >= 0 ? diffMin : null;
}

export function formatarPermanencia(minutos) {
  if (minutos === null || minutos === undefined || isNaN(minutos)) return "-";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${m}min`;
}

export function checkInValido(checkIn) {
  return !!checkIn
    && Object.values(PONTUALIDADE).includes(checkIn.pontualidade)
    && typeof checkIn.dadosConferidos === "boolean";
}

export function checkOutValido(checkOut) {
  return !!checkOut && typeof checkOut.notaFiscal === "string";
}

/* #######################################################################
   PARTE 1B — MODELO TRIDIMENSIONAL DE ESTADOS (ETAPA 1)
   Fonte de verdade a partir desta revisão. 3 dimensões independentes que
   coexistem no mesmo booking sem se sobrescrever, mais o histórico de
   alterações e as funções de leitura/derivação que dão compatibilidade
   com o modelo legado (`status` único).
   ####################################################################### */

// ---- Dimensão 1: administrativa (foi autorizado?) ----
export const APROVACAO = {
  PENDENTE: "PENDENTE",
  APROVADO: "APROVADO",
  RECUSADO: "RECUSADO",
  EXPIRADO: "EXPIRADO",
  CANCELADO: "CANCELADO",
  // Fallback para documentos antigos/incompletos cujo `status` legado não
  // bate com nenhum valor conhecido — não deve aparecer em uso normal.
  SEM_RESPOSTA: "SEM_RESPOSTA"
};

// ---- Dimensão 2: física (o motorista apareceu?) ----
// `null` = ainda não verificado (nenhum check-in nem No-Show registrado).
export const COMPARECIMENTO = {
  NAO_COMPARECEU: "NAO_COMPARECEU",
  COMPARECEU: "COMPARECEU",
  COMPARECEU_ATRASADO: "COMPARECEU_ATRASADO"
};

// ---- Dimensão 3: operacional (está no pátio agora?) ----
export const OPERACIONAL = {
  SEM_CHECKIN: "SEM_CHECKIN",
  EM_PATIO: "EM_PATIO",
  CONCLUIDO: "CONCLUIDO"
};

export const TODAS_APROVACAO = Object.values(APROVACAO);
export const TODOS_COMPARECIMENTO = Object.values(COMPARECIMENTO);
export const TODOS_OPERACIONAL = Object.values(OPERACIONAL);

/**
 * Monta uma entrada de histórico para `historicoEstados`. `dataHora` é um
 * Date do cliente (não serverTimestamp — Firestore não aceita
 * serverTimestamp() dentro de arrayUnion), só para trilha/exibição leve;
 * a ordenação/auditoria "de verdade" continua em `auditLogs`.
 * @private
 */
function _entradaHistorico(dimensaoAlterada, valorAnterior, novoValor, usuarioId) {
  return {
    dataHora: new Date(),
    dimensaoAlterada,
    valorAnterior: valorAnterior ?? null,
    novoValor: novoValor ?? null,
    usuarioId
  };
}

/**
 * Deriva o `status` legado (string única) a partir das 3 dimensões novas.
 * É a ÚNICA função que deveria decidir esse mapeamento — usada tanto para
 * gravar o campo `status` (compatibilidade com transportadora-dashboard.html
 * e outras leituras antigas) quanto por `situacaoResumoLabel`.
 *
 * @param {{aprovacaoStatus: string, comparecimentoStatus: string|null, operacionalStatus: string}} dims
 * @returns {string} um dos valores de STATUS
 */
export function derivarStatusLegado(dims) {
  const { aprovacaoStatus, comparecimentoStatus, operacionalStatus } = dims;

  if (aprovacaoStatus === APROVACAO.RECUSADO) return STATUS.RECUSADO;
  if (aprovacaoStatus === APROVACAO.EXPIRADO) return STATUS.EXPIRADO;
  if (aprovacaoStatus === APROVACAO.CANCELADO) return STATUS.CANCELADO;

  if (comparecimentoStatus === COMPARECIMENTO.NAO_COMPARECEU) return STATUS.NO_SHOW;
  if (operacionalStatus === OPERACIONAL.CONCLUIDO) return STATUS.CONCLUIDO;
  if (operacionalStatus === OPERACIONAL.EM_PATIO) return STATUS.EM_PATIO;

  if (aprovacaoStatus === APROVACAO.APROVADO) return STATUS.APROVADO;
  return STATUS.PENDENTE;
}

/**
 * Mesma ideia de `derivarStatusLegado`, mas devolve o rótulo "de
 * exibição" que `logistica-dashboard.html` já espera (usado em
 * `situacaoResumoLabel(b)` para badges/contadores da Portaria e do
 * Painel do Dia). Hoje os valores coincidem 1:1 com o status legado —
 * mantido como função própria (em vez de reaproveitar
 * `derivarStatusLegado` por fora) para permitir que rótulo de exibição e
 * status legado divirjam no futuro sem quebrar um pelo outro.
 *
 * @param {object} booking - precisa ter aprovacaoStatus/comparecimentoStatus/operacionalStatus
 *   (rode `normalizarBooking` antes se o documento pode ser antigo)
 * @returns {string}
 */
export function situacaoResumoLabel(booking) {
  return derivarStatusLegado({
    aprovacaoStatus: booking.aprovacaoStatus,
    comparecimentoStatus: booking.comparecimentoStatus,
    operacionalStatus: booking.operacionalStatus
  });
}

/**
 * Deriva as 3 dimensões novas a partir de um `status` legado — usada por
 * `normalizarBooking` para "traduzir" documentos antigos on-the-fly, sem
 * precisar rodar uma migração em massa no Firestore antes de colocar as
 * telas novas no ar.
 *
 * @param {string} statusLegado - um dos valores de STATUS
 * @param {object} [booking] - booking original, usado só para reaproveitar
 *   `checkIn.pontualidade` (se existir) ao decidir entre COMPARECEU e
 *   COMPARECEU_ATRASADO
 * @returns {{aprovacaoStatus: string, comparecimentoStatus: string|null, operacionalStatus: string}}
 */
export function derivarDimensoesDoStatusLegado(statusLegado, booking = {}) {
  switch (statusLegado) {
    case STATUS.PENDENTE:
      return { aprovacaoStatus: APROVACAO.PENDENTE, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.APROVADO:
      return { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.RECUSADO:
      return { aprovacaoStatus: APROVACAO.RECUSADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.EXPIRADO:
      return { aprovacaoStatus: APROVACAO.EXPIRADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.CANCELADO:
      return { aprovacaoStatus: APROVACAO.CANCELADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.EM_PATIO: {
      const atrasado = booking.checkIn?.pontualidade === PONTUALIDADE.ATRASADO;
      return { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: atrasado ? COMPARECIMENTO.COMPARECEU_ATRASADO : COMPARECIMENTO.COMPARECEU, operacionalStatus: OPERACIONAL.EM_PATIO };
    }
    case STATUS.CONCLUIDO: {
      const atrasado = booking.checkIn?.pontualidade === PONTUALIDADE.ATRASADO;
      return { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: atrasado ? COMPARECIMENTO.COMPARECEU_ATRASADO : COMPARECIMENTO.COMPARECEU, operacionalStatus: OPERACIONAL.CONCLUIDO };
    }
    case STATUS.NO_SHOW:
      return { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: COMPARECIMENTO.NAO_COMPARECEU, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    default:
      // status ausente/desconhecido — fallback seguro, nunca deveria
      // aparecer em uso normal (documento incompleto/corrompido).
      return { aprovacaoStatus: APROVACAO.SEM_RESPOSTA, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
  }
}

/**
 * Garante que um booking (vindo de `getDocs`/`getDoc`, novo ou antigo)
 * tenha as 3 dimensões novas preenchidas, sem alterar nada no Firestore
 * (é uma tradução só em memória, para leitura pelas telas). Documentos
 * já gravados no modelo novo passam praticamente inalterados; documentos
 * só com `status` legado ganham os 3 campos derivados dele.
 *
 * `logistica-dashboard.html` chama isso em cada booking lido de
 * `carregarDadosGerais()`, então tanto agendamentos criados antes desta
 * revisão quanto os novos aparecem corretamente na tela sem precisar de
 * nenhuma migração manual dos dados existentes no Firestore.
 *
 * @param {object} booking - objeto já com `{ id, ...doc.data() }`
 * @returns {object} o mesmo booking, com aprovacaoStatus/comparecimentoStatus/operacionalStatus garantidos
 */
export function normalizarBooking(booking) {
  if (booking && booking.aprovacaoStatus) {
    // Já está no modelo novo — só garante o histórico como array (nunca
    // undefined) para quem for iterar sobre ele na tela.
    return { historicoEstados: [], ...booking };
  }
  const dims = derivarDimensoesDoStatusLegado(booking?.status, booking);
  return { historicoEstados: [], ...booking, ...dims };
}

/* #######################################################################
   PARTE 2 — DISPONIBILIDADE
   Motor de cálculo de horários/vagas disponíveis (inalterado nesta etapa).
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

export function idSlotHorario(dataStr, horaInicio) {
  return `${dataStr}_${horaInicio.replace(":", "-")}`;
}

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
  return new Date(ano, mes - 1, dia).getDay();
}

export async function buscarSlotsVirtuaisDoDia(db, dataStr, opcoes = {}) {
  const { incluirFechados = false } = opcoes;
  const diaSemana = diaSemanaDaData(dataStr);
  const mapa = {};

  const snapRegras = await getDocs(query(collection(db, "timeSlotRules"), where("ativo", "==", true)));
  snapRegras.docs.forEach(d => {
    const r = d.data();
    if (!(r.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(r).forEach(min => {
      mapa[minutosParaHora(min)] = { capacidadeMax: r.capacidadePorHora, origem: "regra" };
    });
  });

  const snapExc = await getDocs(query(collection(db, "timeSlotExceptions"), where("ativo", "==", true)));
  snapExc.docs.forEach(d => {
    const ex = d.data();
    if (!(ex.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(ex).forEach(min => {
      const hora = minutosParaHora(min);
      if (Number(ex.capacidadePorHora) <= 0) {
        delete mapa[hora];
      } else {
        mapa[hora] = { capacidadeMax: ex.capacidadePorHora, origem: "excecao" };
      }
    });
  });

  const padraoAtual = {};
  Object.keys(mapa).forEach(hora => { padraoAtual[hora] = mapa[hora].capacidadeMax; });

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

export async function obterHorariosDisponiveis(db, dataStr, opcoes = {}) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataStr, opcoes);
  return slots.map(slot => ({
    ...slot,
    vagasRestantes: Math.max(0, (slot.capacidadeMax || 0) - (slot.ocupados || 0))
  }));
}

/* #######################################################################
   PARTE 3 — AGENDAMENTO OPERACIONAL E DA TRANSPORTADORA
   Ambas as funções agora gravam, além dos campos de sempre, as 3
   dimensões novas (aprovacaoStatus/comparecimentoStatus/operacionalStatus)
   E o `status` legado derivado delas (via derivarStatusLegado) — dois
   formatos no mesmo documento, escritos juntos, na mesma transação.
   ####################################################################### */

const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CAPACIDADE_PADRAO_FORA_DO_PADRAO = 1;

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

async function buscarCapacidadeReferencia(db, dataAgendada, horaInicio) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataAgendada, { incluirFechados: true });
  const slot = slots.find(s => s.horaInicio === horaInicio);
  return slot ? slot : null;
}

/**
 * Cria um agendamento OPERACIONAL: já nasce Aprovado (nas 3 dimensões:
 * aprovacaoStatus=APROVADO, comparecimentoStatus=null, operacionalStatus=
 * SEM_CHECKIN), registrado diretamente pela Logística/Admin.
 * @returns {Promise<{bookingId: string, slotId: string, capacidadeMax: number, ocupados: number, capacidadeForcada: boolean}>}
 */
export async function criarAgendamentoOperacional(db, usuarioLogado, dados, opcoes = {}) {
  const { forcarAlemDaCapacidade = false, ignorarFechado = false } = opcoes;

  if (!usuarioLogado || !usuarioLogado.uid) {
    throw new Error("Usuário da Logística/Admin não identificado.");
  }

  validarCamposObrigatorios(dados);

  const transportadoraCadastrada = await buscarTransportadoraCadastrada(db, dados.transportadoraId);

  const dataAgendada = dados.dataAgendada;
  const horaInicio = dados.horaInicio;
  const horaFim = minutosParaHora((horaParaMinutos(horaInicio) + 60) % (24 * 60));

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

  const dimsIniciais = {
    aprovacaoStatus: APROVACAO.APROVADO,
    comparecimentoStatus: null,
    operacionalStatus: OPERACIONAL.SEM_CHECKIN
  };

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
      // Modelo novo (fonte de verdade)
      ...dimsIniciais,
      historicoEstados: [
        _entradaHistorico("aprovacaoStatus", null, dimsIniciais.aprovacaoStatus, usuarioLogado.uid),
        _entradaHistorico("operacionalStatus", null, dimsIniciais.operacionalStatus, usuarioLogado.uid)
      ],
      // Legado (compatibilidade — sempre derivado do bloco acima)
      status: derivarStatusLegado(dimsIniciais),
      tipoAgendamento: TIPO_AGENDAMENTO.OPERACIONAL,
      vagaLiberada: false,
      criadoEm: serverTimestamp(),
      criadoPor: usuarioLogado.uid,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });

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

/**
 * Cria um agendamento enviado pela própria Transportadora (nasce
 * Pendente nas 3 dimensões: aprovacaoStatus=PENDENTE, comparecimentoStatus=
 * null, operacionalStatus=SEM_CHECKIN — aguardando aprovação da Logística).
 * @returns {Promise<{bookingId: string, slotId: string}>}
 */
export async function criarAgendamentoTransportadora(db, usuarioAtual, dados, slotReferencia) {
  if (!usuarioAtual || !usuarioAtual.uid) {
    throw new Error("Usuário não identificado.");
  }

  validarCamposObrigatorios(dados);

  if (!slotReferencia) {
    throw new Error("Este horário não está mais disponível. Selecione a data novamente.");
  }

  const slotId = idSlotHorario(dados.dataAgendada, dados.horaInicio);
  const slotRef = doc(db, "timeSlots", slotId);
  const bookingRef = doc(collection(db, "bookings"));

  const dimsIniciais = {
    aprovacaoStatus: APROVACAO.PENDENTE,
    comparecimentoStatus: null,
    operacionalStatus: OPERACIONAL.SEM_CHECKIN
  };

  await runTransaction(db, async (transaction) => {
    const slotSnap = await transaction.get(slotRef);

    let capacidadeMax;
    let ocupadosAtuais;

    if (!slotSnap.exists()) {
      capacidadeMax = slotReferencia.capacidadeMax;
      ocupadosAtuais = 0;
    } else {
      const slotData = slotSnap.data();
      if (slotData.ativo === false) {
        throw new Error("O horário selecionado não está mais disponível.");
      }
      capacidadeMax = slotData.capacidadeMax;
      ocupadosAtuais = slotData.ocupados || 0;
    }

    if (ocupadosAtuais >= capacidadeMax) {
      throw new Error("As vagas para este horário acabaram de esgotar. Escolha outro horário.");
    }

    transaction.set(slotRef, {
      data: dados.dataAgendada,
      horaInicio: dados.horaInicio,
      horaFim: slotReferencia.horaFim,
      capacidadeMax,
      ativo: true,
      ocupados: ocupadosAtuais + 1
    }, { merge: true });

    transaction.set(bookingRef, {
      usuarioId: usuarioAtual.uid,
      empresa: String(dados.empresa).trim(),
      tipoProcessoId: dados.tipoProcessoId,
      dataAgendada: dados.dataAgendada,
      horaInicio: dados.horaInicio,
      horaFim: slotReferencia.horaFim,
      placaCavalo: String(dados.placaCavalo).trim().toUpperCase(),
      placaCarreta: dados.placaCarreta ? String(dados.placaCarreta).trim().toUpperCase() : "",
      motorista: String(dados.motorista).trim(),
      observacoes: dados.observacoes ? String(dados.observacoes).trim() : "",
      ...dimsIniciais,
      historicoEstados: [
        _entradaHistorico("aprovacaoStatus", null, dimsIniciais.aprovacaoStatus, usuarioAtual.uid)
      ],
      status: derivarStatusLegado(dimsIniciais),
      tipoAgendamento: TIPO_AGENDAMENTO.ANTECIPADO,
      vagaLiberada: false,
      criadoEm: serverTimestamp()
    });
  });

  try {
    await addDoc(collection(db, "auditLogs"), {
      bookingId: bookingRef.id,
      usuarioId: usuarioAtual.uid,
      acao: "Solicitou",
      dataHora: serverTimestamp()
    });
  } catch (errAudit) {
    console.error("Erro ao registrar log de auditoria do agendamento da Transportadora:", errAudit);
  }

  return { bookingId: bookingRef.id, slotId };
}

/* #######################################################################
   PARTE 4 — KPI METRICS (inalterado — continua lendo o `status` legado,
   que agora é sempre derivado das 3 dimensões novas, então os números
   continuam corretos sem precisar tocar nesta parte nesta etapa).
   ####################################################################### */

export function filtrarBookings(bookings, dataInicio, dataFim, empresa = "todas") {
  return bookings.filter(b => {
    if (dataInicio && b.dataAgendada < dataInicio) return false;
    if (dataFim && b.dataAgendada > dataFim) return false;
    if (empresa && empresa !== "todas" && b.empresa !== empresa) return false;
    return true;
  });
}

export function calcularKPIs(bookingsFiltrados) {
  const totalGeral = bookingsFiltrados.length;

  const previstos = bookingsFiltrados.filter(b =>
    [STATUS.CONCLUIDO, STATUS.EM_PATIO, STATUS.APROVADO, STATUS.NO_SHOW].includes(b.status)
  );
  const totalPrevistos = previstos.length;
  const totalNoShow = previstos.filter(b => b.status === STATUS.NO_SHOW).length;
  const taxaNoShow = totalPrevistos > 0 ? ((totalNoShow / totalPrevistos) * 100).toFixed(1) : "0.0";

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

  const totalEncaixes = bookingsFiltrados.filter(b => b.tipoAgendamento === TIPO_AGENDAMENTO.PORTARIA).length;
  const totalPrevio = totalGeral - totalEncaixes;
  const pctPrevio = totalGeral > 0 ? ((totalPrevio / totalGeral) * 100).toFixed(1) : "0.0";
  const pctEncaixe = totalGeral > 0 ? ((totalEncaixes / totalGeral) * 100).toFixed(1) : "0.0";

  const concluidos = bookingsFiltrados.filter(b =>
    b.status === STATUS.CONCLUIDO && b.checkOut?.permanenciaMinutos !== undefined
  );

  const somaMinutos = concluidos.reduce((acc, b) => acc + (b.checkOut.permanenciaMinutos || 0), 0);
  const mediaMinutos = concluidos.length > 0 ? Math.round(somaMinutos / concluidos.length) : 0;
  const dwellTimeFormatado = formatarPermanencia(mediaMinutos);

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
    pontualidade: { noHorario, antecipado, atrasado, pctNoHorario, pctAntecipado, pctAtrasado },
    modalidade: { totalPrevio, totalEncaixes, pctPrevio, pctEncaixe },
    dwellTime: { mediaMinutos, formatado: dwellTimeFormatado, totalAtendidos: concluidos.length },
    totalDivergencias
  };
}

/* #######################################################################
   PARTE 5 — LIBERAÇÃO DE VAGA (helper interno compartilhado)
   ####################################################################### */

/**
 * Decrementa `timeSlots.ocupados` (nunca abaixo de 0) para o horário do
 * booking informado, DENTRO de uma transação já aberta pelo chamador
 * (precisa ser chamada depois de todos os `transaction.get()` da
 * transação, já que Firestore exige que toda leitura venha antes de
 * qualquer escrita). Reaproveitada por `recusarSolicitacao`,
 * `registrarNoShow` e `mudarStatusBooking` (legado) — um único lugar
 * decide como liberar vaga, em vez de 3 cópias divergentes.
 * @private
 */
function _liberarVagaNaTransacao(transaction, slotSnap) {
  if (slotSnap && slotSnap.exists()) {
    const slotData = slotSnap.data();
    const ocupadosAtuais = slotData.ocupados || 0;
    if (ocupadosAtuais > 0) {
      transaction.set(slotSnap.ref, { ...slotData, ocupados: ocupadosAtuais - 1 }, { merge: true });
    }
  }
}

/**
 * Muda o `status` legado de um booking (API antiga, mantida por
 * compatibilidade com qualquer código ainda não migrado para
 * `aprovarSolicitacao`/`recusarSolicitacao`/`registrarNoShow`). Atualiza
 * também as 3 dimensões novas de forma consistente, via
 * `derivarDimensoesDoStatusLegado`, para o documento nunca ficar com o
 * legado e o modelo novo divergindo entre si.
 *
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

    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const novasDims = derivarDimensoesDoStatusLegado(novoStatus, dadosAtuais);

    const payloadBooking = {
      status: novoStatus,
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: novasDims.operacionalStatus,
      historicoEstados: arrayUnion(
        _entradaHistorico("status(legado)", statusAtual, novoStatus, usuarioLogado.uid)
      ),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      _liberarVagaNaTransacao(transaction, slotSnap);
      payloadBooking.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payloadBooking);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

/* #######################################################################
   PARTE 6 — AÇÕES DA LOGÍSTICA SOBRE A DIMENSÃO DE APROVAÇÃO
   Substituem, para quem já migrou (logistica-dashboard.html), as
   chamadas genéricas a `mudarStatusBooking(..., STATUS.APROVADO/RECUSADO)`
   por funções que falam a língua do modelo novo diretamente.
   ####################################################################### */

/**
 * Aprova uma solicitação Pendente. Não mexe em vaga (Pendente e Aprovado
 * já contam igualmente como vaga ocupada).
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado
 * @param {string} bookingId
 */
export async function aprovarSolicitacao(db, usuarioLogado, bookingId) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    // BUGFIX: ver comentário equivalente em registrarCheckIn.
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.aprovacaoStatus !== APROVACAO.PENDENTE) {
      throw new Error(`Este agendamento não está mais Pendente (situação atual: "${situacaoResumoLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }

    const novasDims = { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: dadosAtuais.comparecimentoStatus, operacionalStatus: dadosAtuais.operacionalStatus };

    transaction.update(bookingRef, {
      // Grava as 3 dimensões por completo (auto-cura de documento antigo).
      aprovacaoStatus: APROVACAO.APROVADO,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: novasDims.operacionalStatus,
      status: derivarStatusLegado(novasDims),
      historicoEstados: arrayUnion(_entradaHistorico("aprovacaoStatus", APROVACAO.PENDENTE, APROVACAO.APROVADO, usuarioLogado.uid)),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

/**
 * Recusa uma solicitação Pendente e libera a vaga automaticamente (na
 * mesma transação — ou os dois gravam juntos, ou nenhum grava).
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado
 * @param {string} bookingId
 * @returns {Promise<{vagaLiberada: boolean}>}
 */
export async function recusarSolicitacao(db, usuarioLogado, bookingId) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);
  let vagaFoiLiberada = false;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    // BUGFIX: ver comentário equivalente em registrarCheckIn.
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.aprovacaoStatus !== APROVACAO.PENDENTE) {
      throw new Error(`Este agendamento não está mais Pendente (situação atual: "${situacaoResumoLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }

    const precisaLiberarVaga = dadosAtuais.vagaLiberada !== true;
    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const novasDims = { aprovacaoStatus: APROVACAO.RECUSADO, comparecimentoStatus: dadosAtuais.comparecimentoStatus, operacionalStatus: dadosAtuais.operacionalStatus };

    const payload = {
      // Grava as 3 dimensões por completo (auto-cura de documento antigo).
      aprovacaoStatus: APROVACAO.RECUSADO,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: novasDims.operacionalStatus,
      status: derivarStatusLegado(novasDims),
      historicoEstados: arrayUnion(_entradaHistorico("aprovacaoStatus", APROVACAO.PENDENTE, APROVACAO.RECUSADO, usuarioLogado.uid)),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      _liberarVagaNaTransacao(transaction, slotSnap);
      payload.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payload);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

/* #######################################################################
   PARTE 7 — MÓDULO PORTARIA: CHECK-IN, CHECK-OUT, NO-SHOW, ENCAIXE
   Ações manuais disparadas pela tela (sem regra automática — isso fica
   para uma etapa futura). Cada função mexe só na(s) dimensão(ões) que
   diz respeito à ação, sem tocar nas outras.
   ####################################################################### */

/**
 * Registra o Check-in: dimensão comparecimento (null -> COMPARECEU ou
 * COMPARECEU_ATRASADO, conforme pontualidade) + dimensão operacional
 * (SEM_CHECKIN -> EM_PATIO). Não mexe em aprovacaoStatus.
 *
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado
 * @param {string} bookingId
 * @param {{placaCavalo:string, placaCarreta?:string, motorista:string}} dadosConfirmados
 *   valores confirmados/corrigidos pela Portaria no momento da entrada
 */
export async function registrarCheckIn(db, usuarioLogado, bookingId, dadosConfirmados) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    // BUGFIX: antes lia snap.data() "cru". Documentos criados/gravados
    // antes da Etapa 1 (modelo tridimensional) podem não ter
    // aprovacaoStatus/comparecimentoStatus/operacionalStatus gravados —
    // sem normalizar, os campos vinham `undefined` e a checagem abaixo
    // SEMPRE falhava com "situação atual: Pendente", mesmo o agendamento
    // estando de fato Aprovado (a tela mostrava o botão de Check-in
    // porque ela lê a lista já normalizada em memória; a transação lia o
    // documento bruto direto do Firestore).
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.aprovacaoStatus !== APROVACAO.APROVADO) {
      throw new Error(`Só é possível dar check-in em agendamentos Aprovados (situação atual: "${situacaoResumoLabel(dadosAtuais)}").`);
    }
    if (dadosAtuais.operacionalStatus !== OPERACIONAL.SEM_CHECKIN) {
      throw new Error(`Este agendamento já tem check-in registrado (situação atual: "${situacaoResumoLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }

    const agora = new Date();
    const pontualidade = calcularPontualidade(dadosAtuais.horaInicio, agora);
    const novoComparecimento = pontualidade === PONTUALIDADE.ATRASADO
      ? COMPARECIMENTO.COMPARECEU_ATRASADO
      : COMPARECIMENTO.COMPARECEU;

    const placaCavalo = String(dadosConfirmados.placaCavalo || "").trim().toUpperCase();
    const placaCarreta = dadosConfirmados.placaCarreta ? String(dadosConfirmados.placaCarreta).trim().toUpperCase() : "";
    const motorista = String(dadosConfirmados.motorista || "").trim();
    const divergente = placaCavalo !== (dadosAtuais.placaCavalo || "")
      || placaCarreta !== (dadosAtuais.placaCarreta || "")
      || motorista !== (dadosAtuais.motorista || "");

    const novasDims = { aprovacaoStatus: dadosAtuais.aprovacaoStatus, comparecimentoStatus: novoComparecimento, operacionalStatus: OPERACIONAL.EM_PATIO };

    transaction.update(bookingRef, {
      placaCavalo,
      placaCarreta,
      motorista,
      // Grava as 3 dimensões por completo (não só as que mudaram) —
      // auto-cura o documento caso ele ainda estivesse no formato antigo.
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: novoComparecimento,
      operacionalStatus: OPERACIONAL.EM_PATIO,
      status: derivarStatusLegado(novasDims),
      checkIn: {
        dataHora: serverTimestamp(),
        pontualidade,
        dadosConferidos: true,
        divergente
      },
      historicoEstados: arrayUnion(
        _entradaHistorico("comparecimentoStatus", null, novoComparecimento, usuarioLogado.uid),
        _entradaHistorico("operacionalStatus", OPERACIONAL.SEM_CHECKIN, OPERACIONAL.EM_PATIO, usuarioLogado.uid)
      ),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

/**
 * Registra o Check-out: dimensão operacional (EM_PATIO -> CONCLUIDO).
 * Não mexe em aprovacaoStatus nem comparecimentoStatus.
 *
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado
 * @param {string} bookingId
 * @param {{notaFiscal:string, observacoesSaida?:string}} dados
 */
export async function registrarCheckOut(db, usuarioLogado, bookingId, dados) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    // BUGFIX: ver comentário equivalente em registrarCheckIn — normaliza
    // o documento lido antes de checar o estado atual.
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.operacionalStatus !== OPERACIONAL.EM_PATIO) {
      throw new Error(`Só é possível dar check-out em veículos Em Pátio (situação atual: "${situacaoResumoLabel(dadosAtuais)}").`);
    }

    const notaFiscal = String(dados.notaFiscal || "").trim();
    if (!notaFiscal) throw new Error("O número da Nota Fiscal é obrigatório para o check-out.");

    const agora = new Date();
    const permanenciaMinutos = calcularTempoPermanenciaMinutos(dadosAtuais.checkIn?.dataHora, agora);

    const novasDims = { aprovacaoStatus: dadosAtuais.aprovacaoStatus, comparecimentoStatus: dadosAtuais.comparecimentoStatus, operacionalStatus: OPERACIONAL.CONCLUIDO };

    transaction.update(bookingRef, {
      // Grava as 3 dimensões por completo (auto-cura de documento antigo).
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: OPERACIONAL.CONCLUIDO,
      status: derivarStatusLegado(novasDims),
      checkOut: {
        dataHora: serverTimestamp(),
        notaFiscal,
        observacoesSaida: dados.observacoesSaida ? String(dados.observacoesSaida).trim() : "",
        permanenciaMinutos: permanenciaMinutos ?? 0
      },
      historicoEstados: arrayUnion(
        _entradaHistorico("operacionalStatus", OPERACIONAL.EM_PATIO, OPERACIONAL.CONCLUIDO, usuarioLogado.uid)
      ),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

/**
 * Registra No-Show: dimensão comparecimento (null -> NAO_COMPARECEU).
 * Libera a vaga automaticamente (mesmo princípio de Recusar — a vaga não
 * fica presa por alguém que nunca chegou). Não mexe em aprovacaoStatus
 * (o agendamento continua "Aprovado" administrativamente; só não
 * compareceu).
 *
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado
 * @param {string} bookingId
 * @returns {Promise<{vagaLiberada: boolean}>}
 */
export async function registrarNoShow(db, usuarioLogado, bookingId) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);
  let vagaFoiLiberada = false;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    // BUGFIX: ver comentário equivalente em registrarCheckIn.
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.aprovacaoStatus !== APROVACAO.APROVADO || dadosAtuais.operacionalStatus !== OPERACIONAL.SEM_CHECKIN) {
      throw new Error(`Só é possível marcar No-Show em agendamentos Aprovados sem check-in (situação atual: "${situacaoResumoLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }

    const precisaLiberarVaga = dadosAtuais.vagaLiberada !== true;
    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const novasDims = { aprovacaoStatus: dadosAtuais.aprovacaoStatus, comparecimentoStatus: COMPARECIMENTO.NAO_COMPARECEU, operacionalStatus: dadosAtuais.operacionalStatus };

    const payload = {
      // Grava as 3 dimensões por completo (auto-cura de documento antigo).
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: COMPARECIMENTO.NAO_COMPARECEU,
      operacionalStatus: novasDims.operacionalStatus,
      status: derivarStatusLegado(novasDims),
      historicoEstados: arrayUnion(_entradaHistorico("comparecimentoStatus", null, COMPARECIMENTO.NAO_COMPARECEU, usuarioLogado.uid)),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      _liberarVagaNaTransacao(transaction, slotSnap);
      payload.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payload);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

/**
 * Cria uma entrada de ENCAIXE (veículo sem agendamento prévio, recebido
 * direto na Portaria). Nasce já com as 3 dimensões "no fim da linha de
 * chegada": Aprovado + Compareceu + Em Pátio — não passa pelas etapas
 * anteriores porque, por definição, o veículo já está fisicamente no
 * pátio no momento em que o registro é criado.
 *
 * Não consome vaga de `timeSlots` de propósito: encaixe é, por natureza,
 * fora da grade de capacidade normal (é a válvula de escape para
 * emergências), então não teria sentido competir pela mesma vaga que um
 * agendamento prévio reservou.
 *
 * @param {Firestore} db
 * @param {{uid:string}} usuarioLogado
 * @param {object} dados - empresa, tipoProcessoId, dataAgendada, horaInicio,
 *   placaCavalo, placaCarreta, motorista, observacoes
 * @returns {Promise<{bookingId: string}>}
 */
export async function criarEntradaEncaixe(db, usuarioLogado, dados) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");
  validarCamposObrigatorios(dados);

  const dimsIniciais = {
    aprovacaoStatus: APROVACAO.APROVADO,
    comparecimentoStatus: COMPARECIMENTO.COMPARECEU,
    operacionalStatus: OPERACIONAL.EM_PATIO
  };

  const bookingRef = await addDoc(collection(db, "bookings"), {
    usuarioId: null,
    transportadoraCadastrada: false,
    empresa: String(dados.empresa).trim(),
    tipoProcessoId: dados.tipoProcessoId,
    dataAgendada: dados.dataAgendada,
    horaInicio: dados.horaInicio,
    horaFim: minutosParaHora((horaParaMinutos(dados.horaInicio) + 60) % (24 * 60)),
    placaCavalo: String(dados.placaCavalo).trim().toUpperCase(),
    placaCarreta: dados.placaCarreta ? String(dados.placaCarreta).trim().toUpperCase() : "",
    motorista: String(dados.motorista).trim(),
    observacoes: dados.observacoes ? String(dados.observacoes).trim() : "",
    ...dimsIniciais,
    historicoEstados: [
      _entradaHistorico("aprovacaoStatus", null, dimsIniciais.aprovacaoStatus, usuarioLogado.uid),
      _entradaHistorico("comparecimentoStatus", null, dimsIniciais.comparecimentoStatus, usuarioLogado.uid),
      _entradaHistorico("operacionalStatus", null, dimsIniciais.operacionalStatus, usuarioLogado.uid)
    ],
    status: derivarStatusLegado(dimsIniciais),
    tipoAgendamento: TIPO_AGENDAMENTO.PORTARIA,
    vagaLiberada: false,
    checkIn: {
      dataHora: serverTimestamp(),
      pontualidade: PONTUALIDADE.PONTUAL,
      dadosConferidos: true,
      divergente: false
    },
    criadoEm: serverTimestamp(),
    criadoPor: usuarioLogado.uid,
    atualizadoEm: serverTimestamp(),
    atualizadoPor: usuarioLogado.uid
  });

  return { bookingId: bookingRef.id };
}

/* #######################################################################
   PARTE 8 — VARREDURA DE VAGAS PRESAS POR CANCELAMENTO DA TRANSPORTADORA
   `transportadora-dashboard.html` (ainda não migrado) grava só o `status`
   legado ("Cancelado") ao cancelar — por isso a varredura abaixo continua
   buscando por `status == "Cancelado"`. Ao liberar, ela também grava
   `aprovacaoStatus: CANCELADO` no mesmo documento, "curando" o registro
   para o modelo novo na primeira vez que a Logística abrir o painel.
   ####################################################################### */

async function liberarVagaSemMudarStatus(db, usuarioLogado, booking) {
  const bookingRef = doc(db, "bookings", booking.id);
  const slotRef = doc(db, "timeSlots", idSlotHorario(booking.dataAgendada, booking.horaInicio));

  await runTransaction(db, async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists()) return;
    if (bookingSnap.data().vagaLiberada === true) return;

    const slotSnap = await transaction.get(slotRef);
    _liberarVagaNaTransacao(transaction, slotSnap);

    transaction.update(bookingRef, {
      vagaLiberada: true,
      // Auto-cura para o modelo novo — só se o documento ainda não tinha
      // sido migrado (não sobrescreve se já estava correto).
      aprovacaoStatus: APROVACAO.CANCELADO,
      comparecimentoStatus: null,
      operacionalStatus: OPERACIONAL.SEM_CHECKIN,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

/**
 * Varredura: busca todos os bookings "Cancelado" (status legado) que
 * ainda não tiveram a vaga liberada. Pensada para rodar automaticamente
 * ao abrir o Painel de Logística.
 * @returns {Promise<number>} quantidade de vagas liberadas nesta varredura
 */
export async function liberarVagasCanceladasPelaTransportadora(db, usuarioLogado) {
  const snap = await getDocs(query(collection(db, "bookings"), where("status", "==", STATUS.CANCELADO)));

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
