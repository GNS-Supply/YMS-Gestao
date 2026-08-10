// =====================================================================
// bookingSchema.js
//
// ETAPA 1 — Expansão do schema de `bookings/{id}` para cobrir a jornada
// completa do caminhão no pátio, não só a aprovação da solicitação:
//
//   Pendente → Aprovado → Em Pátio → Concluído
//                     ↘ No-Show
//   Pendente → Recusado / Expirado / Cancelado
//
// Este módulo NÃO faz nenhuma chamada ao Firestore — é só a definição
// das constantes, do formato dos campos novos e das funções puras de
// cálculo/validação, para serem reaproveitadas por qualquer tela
// (Logística, Admin, futura Portaria) sem duplicar lógica.
//
// Campos novos no documento `bookings/{id}` (além dos já existentes:
// usuarioId, empresa, tipoProcessoId, dataAgendada, horaInicio,
// placaCavalo, placaCarreta, motorista, observacoes, status, criadoEm,
// atualizadoEm, atualizadoPor, vagaLiberada, horaEntrada, horaSaida):
//
//   tipoAgendamento: "Antecipado" | "Portaria/Encaixe"
//     - "Antecipado": fluxo atual, a Transportadora reserva a vaga
//       previamente pelo formulário (transportadora-dashboard.html).
//     - "Portaria/Encaixe": veículo que chega sem reserva prévia e é
//       registrado diretamente pela Logística/Portaria no momento da
//       chegada (tela ainda a ser construída em etapa futura).
//
//   checkIn: {
//     dataHora: Timestamp,                 // gravar com serverTimestamp()
//     pontualidade: "Pontual"|"Adiantado"|"Atrasado",
//     dadosConferidos: boolean             // Logística conferiu placa/motorista na portaria
//   }
//
//   checkOut: {
//     dataHora: Timestamp,                 // gravar com serverTimestamp()
//     notaFiscal: string
//   }
//
//   tempoPermanenciaMinutos: number        // calculado no Check-out
//
// NOTA sobre compatibilidade: os campos horaEntrada/horaSaida (string
// "HH:MM", já usados hoje na aba "Agendamentos de Hoje" e nas Métricas
// Operacionais) continuam funcionando como estão. checkIn/checkOut são
// a estrutura mais rica que deve substituí-los nas próximas etapas
// (dá pra saber pontualidade, se os dados foram conferidos na portaria,
// e a nota fiscal de saída — nenhuma dessas informações cabia em
// horaEntrada/horaSaida). Esta etapa só define o formato; a migração
// das Rules e das telas fica para as próximas etapas.
// =====================================================================

import { horaParaMinutos } from "./disponibilidade.js";

/* =====================================================================
   STATUS
   ===================================================================== */

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

// Status que já existiam antes desta etapa (útil para telas/relatórios
// que ainda não foram migrados e precisam saber o que é "novo").
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
// deve ser liberada (decrementada) — mesma lógica que já existe hoje em
// aplicarNovoStatusAgendamento() no logistica-dashboard.html, mas agora
// com No-Show incluído no grupo.
export const STATUS_LIBERA_VAGA = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.NO_SHOW
];

/* =====================================================================
   MÁQUINA DE ESTADOS — transições permitidas

   Serve tanto para validar no cliente antes de tentar escrever quanto
   como documentação viva do fluxo, para reaproveitar ao desenhar as
   próximas Firestore Rules (etapa futura).
   ===================================================================== */

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

/* =====================================================================
   TIPO DE AGENDAMENTO
   ===================================================================== */

export const TIPO_AGENDAMENTO = {
  ANTECIPADO: "Antecipado",
  PORTARIA: "Portaria/Encaixe"
};

export const TODOS_TIPOS_AGENDAMENTO = Object.values(TIPO_AGENDAMENTO);

/* =====================================================================
   CHECK-IN — pontualidade
   ===================================================================== */

export const PONTUALIDADE = {
  PONTUAL: "Pontual",
  ADIANTADO: "Adiantado",
  ATRASADO: "Atrasado"
};

// Janela em minutos ao redor do horário agendado considerada "Pontual".
// Fora dela, classifica como Adiantado (chegou antes) ou Atrasado
// (chegou depois). Valor conservador — pode virar configurável
// (ex: config/capacidadeGlobal) em etapa futura, se necessário.
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
 * IMPORTANTE: `dataHora` aqui é um JS Date só para calcular a
 * pontualidade no cliente antes de enviar. Na escrita real ao
 * Firestore, o campo `dataHora` do payload deve usar serverTimestamp()
 * (nunca o Date do cliente), para não poder ser forjado — o valor local
 * serve apenas de referência para o cálculo de pontualidade.
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
    dataHoraLocal: dataHoraCheckIn, // referência local; trocar por serverTimestamp() na escrita
    pontualidade: calcularPontualidade(horaAgendada, dataHoraCheckIn, toleranciaMin),
    dadosConferidos: !!dadosConferidos
  };
}

/* =====================================================================
   CHECK-OUT + TEMPO DE PERMANÊNCIA
   ===================================================================== */

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
 * Formata minutos em texto legível ("1h20min" / "45min"), mesmo padrão
 * já usado na aba Métricas Operacionais do painel de Logística.
 * @param {number} minutos
 * @returns {string}
 */
export function formatarPermanencia(minutos) {
  if (minutos === null || minutos === undefined || isNaN(minutos)) return "-";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${m}min`;
}

/* =====================================================================
   VALIDAÇÃO DE FORMA (uso no cliente antes de gravar — não substitui
   as Firestore Rules, que continuam sendo a fonte de verdade)
   ===================================================================== */

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
