// =====================================================================
// kpiMetrics.js — Motor de Cálculo de KPIs e Métricas Operacionais
// =====================================================================
import {
  STATUS,
  PONTUALIDADE,
  TIPO_AGENDAMENTO,
  formatarPermanencia
} from "./bookingSchema.js";

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
    if (p === PONTUALIDADE.NO_HORARIO) noHorario++;
    else if (p === PONTUALIDADE.ANTECIPADO) antecipado++;
    else if (p === PONTUALIDADE.ATRASADO) atrasado++;
  });

  const pctNoHorario = totalCheckIns > 0 ? ((noHorario / totalCheckIns) * 100).toFixed(1) : "0.0";
  const pctAntecipado = totalCheckIns > 0 ? ((antecipado / totalCheckIns) * 100).toFixed(1) : "0.0";
  const pctAtrasado = totalCheckIns > 0 ? ((atrasado / totalCheckIns) * 100).toFixed(1) : "0.0";

  // 3. Agendamento Prévio vs Encaixes
  const totalEncaixes = bookingsFiltrados.filter(b => b.tipoAgendamento === TIPO_AGENDAMENTO.PORTARIA_ENCAIXE).length;
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
