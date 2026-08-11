// =====================================================================
// scripts/expirar-pendentes.mjs
//
// Varredura de expiração automática de agendamentos "Pendente".
//
// Roda via GitHub Actions (.github/workflows/expirar-pendentes.yml) —
// NÃO faz parte do site publicado. O front-end continua 100% estático
// (HTML/CSS/JS puro, sem build, sem backend). Esta é a única peça do
// projeto que roda fora do navegador.
//
// Por quê GitHub Actions e não Cloud Functions agendada? Cloud
// Functions com trigger de tempo (Pub/Sub scheduler) exige o plano
// Blaze do Firebase (pay-as-you-go, precisa cadastrar cartão mesmo que
// o uso fique dentro da faixa gratuita). GitHub Actions com cron
// agendado é gratuito, não pede cartão, e já é a mesma plataforma que
// hospeda o site — por isso foi a opção escolhida enquanto o projeto
// usa só GitHub + Firebase.
//
// O Firebase Admin SDK IGNORA as Firestore Rules (elas só valem para o
// SDK client-side, usado no navegador). Por isso a liberação de vaga é
// replicada aqui manualmente, nos mesmos moldes de mudarStatusBooking()
// em patioCore.js: tudo dentro de uma única transação (ou o booking
// muda para "Expirado" E a vaga é liberada juntos, ou nada é gravado).
//
// Credenciais: variável de ambiente FIREBASE_SERVICE_ACCOUNT_JSON deve
// conter o JSON da Service Account (Firebase Console > Configurações
// do Projeto > Contas de serviço > Gerar nova chave privada), como
// texto puro. No GitHub Actions isso vem de um Secret do repositório
// — nunca comitar esse JSON no código.
//
// Variáveis de ambiente opcionais:
//   TOLERANCIA_HORAS - quantas horas antes do horário agendado um
//     "Pendente" ainda sem resposta já deve expirar (padrão: 2).
//   FUSO_OFFSET - offset de fuso horário usado para interpretar
//     dataAgendada + horaInicio (padrão: "-03:00", horário de Brasília,
//     que não tem mais horário de verão desde 2019).
// =====================================================================

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const TOLERANCIA_HORAS = Number(process.env.TOLERANCIA_HORAS || 2);
const FUSO_OFFSET = process.env.FUSO_OFFSET || "-03:00";

function carregarCredencial() {
  const bruto = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!bruto) {
    throw new Error("Variável de ambiente FIREBASE_SERVICE_ACCOUNT_JSON não definida.");
  }
  try {
    return JSON.parse(bruto);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não é um JSON válido: " + err.message);
  }
}

// Converte dataAgendada ("AAAA-MM-DD") + horaInicio ("HH:MM") num
// timestamp absoluto, assumindo o fuso configurado em FUSO_OFFSET —
// necessário porque o runner do GitHub Actions roda em UTC, não no
// fuso do pátio.
function dataHoraAgendadaEmMs(dataAgendada, horaInicio) {
  return new Date(`${dataAgendada}T${horaInicio}:00${FUSO_OFFSET}`).getTime();
}

function idSlotHorario(dataStr, horaInicio) {
  return `${dataStr}_${horaInicio.replace(":", "-")}`;
}

async function expirarBooking(db, bookingRef) {
  await db.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists) return;
    const atual = bookingSnap.data();

    // Revalida dentro da transação: só expira quem ainda está Pendente
    // — protege contra corrida com uma aprovação/recusa manual feita
    // entre a consulta inicial (fora da transação) e esta execução.
    if (atual.status !== "Pendente") return;

    const slotRef = db.collection("timeSlots").doc(idSlotHorario(atual.dataAgendada, atual.horaInicio));
    const slotSnap = await transaction.get(slotRef);

    const payloadBooking = {
      status: "Expirado",
      atualizadoEm: FieldValue.serverTimestamp(),
      atualizadoPor: "sistema-expiracao-automatica"
    };

    if (atual.vagaLiberada !== true && slotSnap.exists) {
      const slotData = slotSnap.data();
      const ocupadosAtuais = slotData.ocupados || 0;
      if (ocupadosAtuais > 0) {
        transaction.set(slotRef, { ...slotData, ocupados: ocupadosAtuais - 1 }, { merge: true });
      }
      payloadBooking.vagaLiberada = true;
    }

    transaction.update(bookingRef, payloadBooking);

    const logRef = db.collection("auditLogs").doc();
    transaction.set(logRef, {
      bookingId: bookingRef.id,
      usuarioId: "sistema-expiracao-automatica",
      acao: "Expirou",
      dataHora: FieldValue.serverTimestamp()
    });
  });
}

async function main() {
  const credencial = carregarCredencial();
  initializeApp({ credential: cert(credencial) });
  const db = getFirestore();

  const agora = Date.now();
  const limiteMs = TOLERANCIA_HORAS * 60 * 60 * 1000;

  const snap = await db.collection("bookings").where("status", "==", "Pendente").get();

  let totalVerificados = 0;
  let totalExpirados = 0;

  for (const doc of snap.docs) {
    totalVerificados++;
    const dados = doc.data();
    if (!dados.dataAgendada || !dados.horaInicio) continue;

    const faltamMs = dataHoraAgendadaEmMs(dados.dataAgendada, dados.horaInicio) - agora;

    if (faltamMs <= limiteMs) {
      try {
        await expirarBooking(db, doc.ref);
        totalExpirados++;
        console.log(`Expirado: ${doc.id} (${dados.empresa || "-"}, ${dados.dataAgendada} ${dados.horaInicio})`);
      } catch (err) {
        console.error(`Erro ao expirar ${doc.id}:`, err.message);
      }
    }
  }

  console.log(`Varredura concluída: ${totalVerificados} pendente(s) verificado(s), ${totalExpirados} expirado(s).`);
}

main().catch((err) => {
  console.error("Falha na varredura de expiração:", err);
  process.exitCode = 1;
});
